#!/usr/bin/env node
/**
 * Tokimeter Proxy Server
 *
 * A lightweight local proxy that sits between CLI tools (Claude Code, Codex,
 * Aider, Cursor) and the real LLM API. It intercepts requests, forwards them
 * to the real API, reads the token usage from the response, and tracks costs.
 *
 * Usage:
 *   node server.js                    # start on port 8788
 *   PORT=9000 node server.js          # custom port
 *
 * Then set env vars for your CLI tools:
 *   export ANTHROPIC_BASE_URL=http://localhost:8788
 *   export OPENAI_BASE_URL=http://localhost:8788
 *
 * Zero dependencies — uses only Node.js built-in modules.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const { CostTracker } = await importCore();
const { getPricingSource, listModels, priceCall } = await importCorePricing();
const { latestCodexVendorSnapshot } = await import('./parsers.js');
const {
  clearCloudPause,
  cloudPauseActive,
  cloudPauseState,
  cloudResponseResult,
  eventToCloudPayload,
} = await import('./cloud-sync.js');

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.TOKIMETER_PORT || '8788', 10);
const DATA_DIR = process.env.TOKIMETER_DATA_DIR || join(homedir(), '.tokimeter');
const DATA_FILE = join(DATA_DIR, 'calls.jsonl');
const CLOUD_QUEUE_FILE = join(DATA_DIR, 'cloud-pending.jsonl');
const CLOUD_HEALTH_FILE = join(DATA_DIR, 'cloud-sync-health.json');
const CLOUD_SYNC_STATE_FILE = join(DATA_DIR, 'cloud-sync-state.json');
const CONSOLE_OUTPUT = process.env.TOKIMETER_CONSOLE !== '0'; // default: on
// Cloud sync: env vars win; `tokimeter login` stores cloud.url/cloud.apiKey
// in settings.json. Sync stays off unless both URL and key resolve.
const CLOUD_SETTINGS = readCloudSettings();
const CLOUD_URL = (process.env.TOKIMETER_CLOUD_URL || CLOUD_SETTINGS.url || '').replace(/\/$/, '');
const CLOUD_API_KEY = process.env.TOKIMETER_API_KEY || CLOUD_SETTINGS.apiKey || '';
const CLOUD_PROJECT_MODE = process.env.TOKIMETER_CLOUD_PROJECT_MODE || CLOUD_SETTINGS.projectMode || 'basename';
const CODEX_SESSIONS_DIR = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
const LIMIT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const LOCAL_READER_SYNC_INTERVAL_MS = parseInt(process.env.TOKIMETER_CLOUD_SCAN_MS || String(5 * 60 * 1000), 10);

function readCloudSettings() {
  try {
    const settings = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8'));
    const cloud = settings?.cloud;
    return cloud && typeof cloud === 'object'
      ? {
          url: String(cloud.url || ''),
          apiKey: String(cloud.apiKey || ''),
          projectMode: String(cloud.projectMode || 'basename'),
        }
      : {};
  } catch {
    return {};
  }
}
const CLOUD_RETRY_INTERVAL_MS = parseInt(process.env.TOKIMETER_CLOUD_RETRY_MS || '15000', 10);
const CLOUD_RETRY_MAX_MS = parseInt(process.env.TOKIMETER_CLOUD_RETRY_MAX_MS || String(15 * 60 * 1000), 10);
const CLOUD_QUEUE_MAX_ITEMS = parseInt(process.env.TOKIMETER_CLOUD_QUEUE_MAX_ITEMS || '10000', 10);
const CLOUD_QUEUE_MAX_BYTES = parseInt(process.env.TOKIMETER_CLOUD_QUEUE_MAX_BYTES || String(10 * 1024 * 1024), 10);
let cloudFlushInProgress = false;
let localReaderSyncInProgress = false;

async function importCore() {
  try {
    return await import('@tokimeter/core');
  } catch {
    try {
      return await import('./core/index.js'); // bundled copy in published package
    } catch {
      return import('../../core/src/index.js'); // monorepo dev
    }
  }
}

async function importCorePricing() {
  try {
    return await import('@tokimeter/core/pricing.js');
  } catch {
    try {
      return await import('./core/pricing.js'); // bundled copy in published package
    } catch {
      return import('../../core/src/pricing.js'); // monorepo dev
    }
  }
}

// ─── API endpoint mapping ───────────────────────────────────────────────────

/**
 * Maps incoming request paths to the real upstream API.
 * Detects provider from the URL path and routes accordingly.
 */
function resolveUpstream(reqUrl, headers) {
  const path = reqUrl.path || reqUrl.pathname;
  const host = (headers.host || '').toLowerCase();

  // ─── Anthropic (Claude Code, Claude API) ────────────────────────────────
  // ANTHROPIC_BASE_URL=http://localhost:8788
  // Requests come in as: /v1/messages, /v1/complete, etc.
  if (path.startsWith('/v1/messages') || path.startsWith('/v1/complete')) {
    return {
      provider: 'anthropic',
      hostname: process.env.ANTHROPIC_UPSTREAM || 'api.anthropic.com',
      apiBase: '',
    };
  }

  // ─── Legacy ChatGPT backend proxy path ────────────────────────────────
  // Subscription-mode tracking now prefers Codex CLI token-summary capture.
  // Keep this route for older local profiles and diagnostics.
  if (path.startsWith('/backend-api/')) {
    const customBase = process.env.CHATGPT_UPSTREAM || 'https://chatgpt.com';
    const u = new URL(customBase);
    return {
      provider: 'openai',
      hostname: u.hostname,
      apiBase: u.pathname.replace(/\/$/, ''),
    };
  }

  // ─── OpenRouter (any OpenAI-compatible CLI) ────────────────────────────
  // Point the tool at http://localhost:8788/openrouter, e.g.:
  //   OPENAI_BASE_URL=http://localhost:8788/openrouter/v1
  // Requests arrive as /openrouter/v1/chat/completions and are forwarded to
  // https://openrouter.ai/api/v1/... . Usage format is OpenAI-compatible.
  if (path.startsWith('/openrouter/')) {
    return {
      provider: 'openai',
      hostname: 'openrouter.ai',
      apiBase: '/api',
      stripPrefix: '/openrouter',
    };
  }

  // ─── OpenAI (Codex, GPT, etc.) ──────────────────────────────────────────
  // OPENAI_BASE_URL=http://localhost:8788
  // Requests come in as: /v1/chat/completions, /v1/responses, /v1/embeddings
  if (path.startsWith('/v1/chat') || path.startsWith('/v1/completions') ||
      path.startsWith('/v1/responses') || path.startsWith('/v1/embeddings') ||
      path.startsWith('/v1/models')) {
    // Could be real OpenAI, or could be a Velros/gateway with custom host
    const customBase = process.env.OPENAI_UPSTREAM;
    if (customBase) {
      const u = new URL(customBase);
      return { provider: 'openai', hostname: u.hostname, apiBase: u.pathname.replace(/\/$/, '') };
    }
    return { provider: 'openai', hostname: 'api.openai.com', apiBase: '' };
  }

  // ─── Google Gemini (if someone points it here) ──────────────────────────
  // Less common since Gemini uses a different SDK pattern, but handle it
  if (path.includes('/v1beta/') || path.includes('/v1/models/')) {
    return {
      provider: 'google',
      hostname: 'generativelanguage.googleapis.com',
      apiBase: '',
    };
  }

  // ─── Unknown — try to detect from auth header ───────────────────────────
  const auth = headers.authorization || headers['x-api-key'] || '';
  if (auth.startsWith('sk-ant')) {
    return { provider: 'anthropic', hostname: 'api.anthropic.com', apiBase: '' };
  }
  if (auth.startsWith('sk-')) {
    return { provider: 'openai', hostname: 'api.openai.com', apiBase: '' };
  }

  return { provider: 'unknown', hostname: '', apiBase: '' };
}

// ─── Usage extraction ───────────────────────────────────────────────────────

/**
 * Extract token usage from an API response body.
 * Handles OpenAI, Anthropic, and Google response formats.
 */
function extractUsage(provider, body) {
  try {
    const data = JSON.parse(body);
    return extractUsageFromObject(provider, data);
  } catch {
    return extractUsageFromStream(provider, body);
  }
}

function extractUsageFromObject(provider, data) {
  if (provider === 'anthropic') {
    const usage = data.usage || data.message?.usage || {};
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cachedTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      model: data.model || data.message?.model || '',
    };
  }

  if (provider === 'openai') {
    const response = data.response || data;
    const usage = response.usage || {};
    const cached = usage.prompt_tokens_details?.cached_tokens ||
      usage.input_tokens_details?.cached_tokens || 0;
    // Responses API uses input/output tokens; Chat Completions uses prompt/completion.
    const inputT = usage.prompt_tokens || usage.input_tokens || 0;
    const outputT = usage.completion_tokens || usage.output_tokens || 0;
    return {
      inputTokens: inputT,
      outputTokens: outputT,
      cachedTokens: cached,
      model: response.model || data.model || '',
    };
  }

  if (provider === 'google') {
    const usage = data.usageMetadata || {};
    return {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      cachedTokens: usage.cachedContentTokenCount || 0,
      model: data.modelVersion || '',
    };
  }

  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: '' };
}

function extractUsageFromStream(provider, body) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, model: '' };
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const data = JSON.parse(payload);
      const next = extractUsageFromStreamEvent(provider, data);
      usage.inputTokens = Math.max(usage.inputTokens, next.inputTokens || 0);
      usage.outputTokens = Math.max(usage.outputTokens, next.outputTokens || 0);
      usage.cachedTokens = Math.max(usage.cachedTokens, next.cachedTokens || 0);
      usage.cacheCreationTokens = Math.max(usage.cacheCreationTokens, next.cacheCreationTokens || 0);
      if (!usage.model && next.model) usage.model = next.model;
    } catch {
      // Ignore malformed stream lines.
    }
  }

  return usage;
}

function extractUsageFromStreamEvent(provider, data) {
  if (provider === 'anthropic') {
    if (data.type === 'message_start' && data.message) {
      return extractUsageFromObject(provider, data);
    }
    if (data.type === 'message_delta') {
      const usage = data.usage || {};
      return {
        inputTokens: 0,
        outputTokens: usage.output_tokens || 0,
        cachedTokens: 0,
        model: '',
      };
    }
  }

  if (provider === 'openai') {
    if (data.type === 'response.completed' && data.response) {
      return extractUsageFromObject(provider, data.response);
    }
    if (data.usage || data.model) {
      return extractUsageFromObject(provider, data);
    }
  }

  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: '' };
}

// ─── Detect which tool made the request ─────────────────────────────────────

function detectTool(headers) {
  const ua = (headers['user-agent'] || '').toLowerCase();
  if (ua.includes('claude-code')) return 'claude-code';
  if (ua.includes('codex')) return 'codex';
  if (ua.includes('aider')) return 'aider';
  if (ua.includes('cursor')) return 'cursor';
  if (ua.includes('python')) return 'python-sdk';
  if (ua.includes('node')) return 'node-sdk';
  return 'unknown';
}

// ─── Storage ────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function persistCall(call) {
  ensureDataDir();
  try {
    writeFileSync(DATA_FILE, JSON.stringify(call) + '\n', { flag: 'a' });
  } catch (e) {
    // Non-fatal — we don't want to crash the proxy on a write error
  }
}

function recordCall(call) {
  if (call.externalId && seenExternalIds.has(call.externalId)) {
    return false;
  }
  if (!hasBillableOrTokenUsage(call)) {
    return false;
  }
  tracker.record(call);
  if (call.externalId) seenExternalIds.add(call.externalId);
  persistCall(call);
  syncCloudCall(call);
  printCostOutput(call, tracker.getSummary());
  return true;
}

function hasBillableOrTokenUsage(call) {
  const tokenTotal = Math.max(0, Number(call.inputTokens) || 0)
    + Math.max(0, Number(call.outputTokens) || 0)
    + Math.max(0, Number(call.cachedTokens) || 0)
    + Math.max(0, Number(call.cacheCreationTokens) || 0)
    + Math.max(0, Number(call.reasoningTokens) || 0);
  return tokenTotal > 0 || (Number(call.totalCost) || 0) > 0;
}

function normalizeManualCall(data) {
  const timestamp = Number(data.timestamp) || Date.now();
  const inputTokens = Math.max(0, Number(data.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(data.outputTokens) || 0);
  const cachedTokens = Math.max(0, Number(data.cachedTokens) || 0);
  const cacheCreationTokens = Math.max(0, Number(data.cacheCreationTokens) || 0);
  const model = String(data.model || 'unknown');
  const provider = String(data.provider || 'unknown');
  const cost = priceCall(model, inputTokens, outputTokens, cachedTokens, cacheCreationTokens, {
    cachedIncludedInInput: provider !== 'anthropic',
  });
  const source = String(data.source || 'manual');

  return {
    timestamp,
    provider,
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    reasoningTokens: Math.max(0, Number(data.reasoningTokens) || 0),
    inputCost: Number(data.inputCost) || cost.inputCost,
    outputCost: Number(data.outputCost) || cost.outputCost,
    totalCost: Number(data.totalCost) || cost.totalCost,
    latencyMs: Math.max(0, Number(data.latencyMs) || 0),
    success: data.success !== false,
    tool: String(data.tool || 'unknown'),
    source,
    confidence: data.confidence ? String(data.confidence) : confidenceForSource(source),
    pricingConfidence: data.pricingConfidence ? String(data.pricingConfidence) : getPricingSource(model).confidence,
    effort: data.effort ? String(data.effort) : undefined,
    cwd: data.cwd ? String(data.cwd) : undefined,
    sessionId: data.sessionId ? String(data.sessionId) : undefined,
    externalId: data.externalId ? String(data.externalId) : undefined,
    note: data.note ? String(data.note) : undefined,
  };
}

function confidenceForSource(source) {
  if (source === 'claude-transcript-usage') return 'exact';
  if (source === 'codex-rollout-token-count') return 'imported';
  if (source === 'codex-cli-summary') return 'estimated';
  if (source === 'manual') return 'manual';
  return 'tracked';
}

// ─── Console Output ─────────────────────────────────────────────────────────

function formatCostLine(call, summary) {
  const parts = [];

  // Per-call cost
  parts.push(`💰 $${call.totalCost.toFixed(4)}`);

  // Running total
  parts.push(`today: $${summary.todayCost.toFixed(2)} (${summary.todayCalls} calls)`);

  // Lifetime total
  parts.push(`lifetime: $${summary.totalCost.toFixed(2)}`);

  return `✓ ${parts.join(' | ')}`;
}

function printCostOutput(call, summary) {
  if (!CONSOLE_OUTPUT) return;

  process.stderr.write(`\n${formatCostLine(call, summary)}\n`);

  // Show a tip occasionally (every 5th call)
  if (summary.totalCalls % 5 === 0 || summary.totalCalls <= 3) {
    const tip = tracker.getRotatingTip();
    if (tip && !tip.includes('efficient')) {
      process.stderr.write(`${tip}\n`);
    }
  }
  process.stderr.write('\n');
}

// ─── Proxy Handler ──────────────────────────────────────────────────────────

const tracker = new CostTracker();
const seenExternalIds = new Set();
loadPersistedCalls();
if (CLOUD_URL && CLOUD_API_KEY) {
  flushCloudQueue();
  setInterval(flushCloudQueue, CLOUD_RETRY_INTERVAL_MS).unref();
  setTimeout(syncLimitSnapshots, 5000).unref();
  setInterval(syncLimitSnapshots, LIMIT_SYNC_INTERVAL_MS).unref();
  setTimeout(syncAllLocalReaders, 8000).unref();
  setInterval(syncAllLocalReaders, LOCAL_READER_SYNC_INTERVAL_MS).unref();
}

/**
 * Main proxy request handler.
 */
function handleProxy(req, res) {
  const startTime = Date.now();
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const upstream = resolveUpstream(reqUrl, req.headers);

  if (!upstream.hostname) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Tokimeter: Could not determine upstream API from request path',
      path: reqUrl.pathname,
      method: req.method,
      host: req.headers.host || '',
    }));
    return;
  }

  // Collect request body
  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', () => {
    const reqBody = Buffer.concat(bodyChunks);

    // Build upstream request
    const forwardedPathname = upstream.stripPrefix && reqUrl.pathname.startsWith(upstream.stripPrefix)
      ? reqUrl.pathname.slice(upstream.stripPrefix.length)
      : reqUrl.pathname;
    const upstreamPath = upstream.apiBase + forwardedPathname + reqUrl.search;

    const upstreamHeaders = { ...req.headers };
    // Fix host header
    upstreamHeaders.host = upstream.hostname;
    // Remove our local host
    delete upstreamHeaders['content-length'];
    const bodyLength = Buffer.byteLength(reqBody);
    if (bodyLength > 0) {
      upstreamHeaders['content-length'] = bodyLength;
    }

    const options = {
      hostname: upstream.hostname,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      const resChunks = [];
      proxyRes.on('data', chunk => resChunks.push(chunk));
      proxyRes.on('data', chunk => res.write(chunk));
      proxyRes.on('end', () => {
        const resBody = Buffer.concat(resChunks);

        res.end();

        // ─── Track the call ─────────────────────────────────────────────
        const latencyMs = Date.now() - startTime;
        const success = (proxyRes.statusCode || 500) < 400;
        const usage = extractUsage(upstream.provider, resBody.toString());

        // Try to get model from request body if not in response
        let model = usage.model;
        if (!model) {
          try {
            const reqData = JSON.parse(reqBody.toString());
            model = reqData.model || '';
          } catch {}
        }

        const cost = priceCall(
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens,
          usage.cacheCreationTokens || 0,
          { cachedIncludedInInput: upstream.provider !== 'anthropic' }
        );

        const call = {
          timestamp: startTime,
          provider: upstream.provider,
          model: model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          cacheCreationTokens: usage.cacheCreationTokens || 0,
          inputCost: cost.inputCost,
          outputCost: cost.outputCost,
          totalCost: cost.totalCost,
          latencyMs,
          success,
          tool: detectTool(req.headers),
          confidence: 'exact',
          pricingConfidence: getPricingSource(model).confidence,
        };

        recordCall(call);
      });

      // Send headers as soon as upstream responds so streaming callers do not
      // wait for the whole model response before seeing output.
      res.writeHead(proxyRes.statusCode || 200, { ...proxyRes.headers });
    });

    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Tokimeter proxy error: ${e.message}`,
        upstream: upstream.hostname,
      }));
    });

    if (reqBody.length > 0) {
      proxyReq.write(reqBody);
    }
    proxyReq.end();
  });
}

// ─── Dashboard API ──────────────────────────────────────────────────────────

function handleApi(req, res, reqUrl) {
  if (reqUrl.pathname === '/api/track' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const call = normalizeManualCall(data);
        const recorded = recordCall(call);
        res.writeHead(201, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, duplicate: !recorded, call }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid tracking payload' }));
      }
    });
    return;
  }

  if (reqUrl.pathname === '/api/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(tracker.getSummary()));
    return;
  }

  if (reqUrl.pathname === '/api/tips') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ tips: tracker.getTips() }));
    return;
  }

  if (reqUrl.pathname === '/api/calls') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const limit = parseInt(reqUrl.searchParams.get('limit') || '100', 10);
    res.end(JSON.stringify(tracker.getRecentCalls(limit).reverse()));
    return;
  }

  if (reqUrl.pathname === '/api/pricing') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const provider = reqUrl.searchParams.get('provider') || '';
    res.end(JSON.stringify({
      models: listModels(provider).map(price => ({
        provider: price.provider,
        model: price.model,
        input: price.input,
        output: price.output,
        cached: price.cached,
        aliases: price.aliases || [],
        custom: Boolean(price.custom),
      })),
    }));
    return;
  }

  if (reqUrl.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: 'ok',
      calls: tracker.calls.length,
      dataFile: DATA_FILE,
      manualTracking: true,
      callMetadata: true,
      cloudSync: Boolean(CLOUD_URL && CLOUD_API_KEY),
      pendingCloudSync: pendingCloudSyncCount(),
      cloudSyncHealth: readCloudHealth(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'Unknown API endpoint' }));
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // Dashboard API endpoints
  if (reqUrl.pathname.startsWith('/api/')) {
    handleApi(req, res, reqUrl);
    return;
  }

  // Health check
  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      calls: tracker.calls.length,
      dataFile: DATA_FILE,
      manualTracking: true,
      callMetadata: true,
      cloudSync: Boolean(CLOUD_URL && CLOUD_API_KEY),
      pendingCloudSync: pendingCloudSyncCount(),
      cloudSyncHealth: readCloudHealth(),
    }));
    return;
  }

  // Everything else is proxied to the upstream API
  handleProxy(req, res);
});

server.listen(PORT, () => {
  const banner = `
  ╔═══════════════════════════════════════════════════════════════╗
  ║                    Tokimeter Proxy Running                  ║
  ╠═══════════════════════════════════════════════════════════════╣
  ║                                                               ║
  ║  Proxy:   http://localhost:${PORT}                              ║
  ║  API:     http://localhost:${PORT}/api/summary                  ║
  ║  Data:    ${DATA_FILE.padEnd(47)} ║
  ║                                                               ║
  ║  Set these env vars to start tracking:                        ║
  ║                                                               ║
  ║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}           ║
  ║    export OPENAI_BASE_URL=http://localhost:${PORT}             ║
  ║                                                               ║
  ║  Then use Claude Code, Codex, Aider etc. normally.            ║
  ║  Costs appear here in real time.                              ║
  ║                                                               ║
  ║  Press Ctrl+C to stop.                                        ║
  ╚═══════════════════════════════════════════════════════════════╝
  `;
  process.stderr.write(banner + '\n');
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', () => {
  const summary = tracker.getSummary();
  process.stderr.write(`\n  Tokimeter Proxy stopping...\n`);
  process.stderr.write(`  Session: ${summary.totalCalls} calls, $${summary.totalCost.toFixed(4)}\n\n`);
  process.exit(0);
});

function loadPersistedCalls() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const text = readFileSync(DATA_FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const call = JSON.parse(line);
        if (!hasBillableOrTokenUsage(call)) continue;
        tracker.record(call);
        if (call.externalId) seenExternalIds.add(call.externalId);
      } catch {
        // Ignore corrupt lines; JSONL append should keep the rest usable.
      }
    }
  } catch {
    // Missing/unreadable history should not stop the proxy from starting.
  }
}

function syncCloudCall(call) {
  if (!CLOUD_URL || !CLOUD_API_KEY || cloudAccessIsPaused()) return;
  const payload = cloudPayloadForCall(call);

  postCloudPayload(payload, (result) => {
    recordCloudResult(result);
    if (!result.ok && !result.terminalFailure) enqueueCloudPayload(payload);
  });
}

function cloudPayloadForCall(call) {
  return eventToCloudPayload(
    { ...call, source: call.source || 'tokimeter-proxy' },
    { projectMode: CLOUD_PROJECT_MODE }
  );
}

// The proxy owns the long-running process, while the CLI owns vendor-specific
// local readers. Ask the CLI to scan incrementally so Cursor, Grok, Hermes,
// opencode, Cline, Copilot, Codex, and Claude all reach the same cloud meter.
// The child posts directly to the ingest function and keeps its own watermark.
function syncAllLocalReaders() {
  if (localReaderSyncInProgress || !CLOUD_URL || !CLOUD_API_KEY || cloudAccessIsPaused()) return;
  localReaderSyncInProgress = true;
  const cliPath = new URL('./cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cliPath, 'sync', '--quiet'], {
    stdio: 'ignore',
    env: { ...process.env, TOKIMETER_DATA_DIR: DATA_DIR },
  });
  child.unref();
  const done = () => { localReaderSyncInProgress = false; };
  child.once('exit', done);
  child.once('error', done);
}

// The contract endpoints are {cloud}/v1/events and {cloud}/v1/limits. A raw
// Supabase Edge Function URL (…/functions/v1/ingest) is accepted directly and
// both suffixes route inside the one function, so no custom domain is needed.
function cloudUrlFor(suffix) {
  const base = new URL(CLOUD_URL);
  if (base.pathname.includes('/functions/')) return base;   // one function handles both paths
  if (base.pathname.endsWith('/v1/events') || base.pathname.endsWith('/v1/limits')) return base;
  return new URL(`/v1/${suffix}`, base);
}

function postCloudPayload(payload, callback, suffix = 'events') {
  const target = cloudUrlFor(suffix);
  const body = JSON.stringify(payload);
  let settled = false;
  const done = (result) => {
    if (settled) return;
    settled = true;
    callback(result);
  };

  const client = target.protocol === 'https:' ? https : http;
  const req = client.request(target, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CLOUD_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 3000,
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { if (raw.length < 65536) raw += chunk; });
    res.on('end', () => {
      let response = {};
      try { response = JSON.parse(raw); } catch {}
      done(cloudResponseResult(res.statusCode || 500, response));
    });
  });
  req.on('error', (error) => done({ ...cloudResponseResult(0), error: error.message }));
  req.on('timeout', () => {
    req.destroy();
    done({ ...cloudResponseResult(0), error: 'Cloud sync timed out' });
  });
  req.write(body);
  req.end();
}

// Relay the freshest Codex vendor rate-limit snapshot to the cloud so pace
// alerts can fire away from the terminal. Metadata only: percentages, window
// kinds, reset times. Fire-and-forget (snapshots refresh themselves, so no
// retry queue) and only when cloud sync is configured.
function syncLimitSnapshots() {
  if (!CLOUD_URL || !CLOUD_API_KEY || cloudAccessIsPaused()) return;
  let snap;
  try {
    snap = latestCodexVendorSnapshot(CODEX_SESSIONS_DIR, { maxAgeMs: 86400 * 1000 });
  } catch {
    return;
  }
  if (!snap) return;
  const capturedAt = new Date(snap.timestamp).toISOString();
  const send = (window, kind) => {
    if (!window || window.resetsAtMs == null) return;
    postCloudPayload({
      contract_version: 1,
      tool: 'codex',
      window_kind: kind,
      used_percent: window.usedPercent,
      resets_at: new Date(window.resetsAtMs).toISOString(),
      plan_type: snap.planType || null,
      captured_at: capturedAt,
    }, recordCloudResult, 'limits');
  };
  send(snap.primary, '5h');
  send(snap.secondary, 'weekly');
}

function enqueueCloudPayload(payload) {
  ensureDataDir();
  try {
    const entries = readCloudQueueEntries();
    entries.push({ payload, attempts: 0, nextAttemptAt: Date.now(), firstFailedAt: new Date().toISOString() });
    let dropped = 0;
    let encodedBytes = queueEncodedBytes(entries);
    while (entries.length > CLOUD_QUEUE_MAX_ITEMS || encodedBytes > CLOUD_QUEUE_MAX_BYTES) {
      const removed = entries.shift();
      if (removed) encodedBytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
      dropped += 1;
    }
    writeCloudQueueEntries(entries);
    updateCloudHealth({ pending: entries.length, lastFailureAt: new Date().toISOString(), droppedDelta: dropped });
  } catch {
    // Local tracking should continue even if the retry queue cannot be written.
  }
}

async function flushCloudQueue() {
  if (!CLOUD_URL || !CLOUD_API_KEY || cloudFlushInProgress || cloudAccessIsPaused() || !existsSync(CLOUD_QUEUE_FILE)) return;
  cloudFlushInProgress = true;
  try {
    const entries = readCloudQueueEntries();
    const remaining = [];
    let succeeded = 0;
    let failed = 0;
    let attempted = 0;
    const now = Date.now();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (Number(entry.nextAttemptAt || 0) > now || attempted >= 200) { remaining.push(entry); continue; }
      attempted += 1;
      const result = await postCloudPayloadAsync(entry.payload);
      recordCloudResult(result);
      if (result.ok) {
        succeeded += 1;
      } else if (result.terminalFailure) {
        // Keep every queued metadata item locally and stop. A manual
        // `tokimeter sync` after upgrade clears the pause immediately; the
        // automatic entitlement probe is capped at once per day.
        remaining.push(entry, ...entries.slice(index + 1));
        break;
      } else {
        failed += 1;
        const attempts = Math.max(0, Number(entry.attempts || 0)) + 1;
        const base = Math.min(CLOUD_RETRY_MAX_MS, CLOUD_RETRY_INTERVAL_MS * (2 ** Math.min(attempts, 10)));
        const jitter = Math.floor(base * (0.15 * Math.random()));
        remaining.push({ ...entry, attempts, nextAttemptAt: now + base + jitter, lastFailedAt: new Date().toISOString() });
      }
    }
    writeCloudQueueEntries(remaining);
    updateCloudHealth({
      pending: remaining.length,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: succeeded ? new Date().toISOString() : undefined,
      lastFailureAt: failed ? new Date().toISOString() : undefined,
    });
  } catch {
    // Retry on the next interval.
  } finally {
    cloudFlushInProgress = false;
  }
}

function postCloudPayloadAsync(payload) {
  return new Promise(resolve => postCloudPayload(payload, resolve));
}

function readCloudSyncState() {
  try { return JSON.parse(readFileSync(CLOUD_SYNC_STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeCloudSyncState(state) {
  try {
    ensureDataDir();
    writeFileSync(CLOUD_SYNC_STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

function cloudAccessIsPaused() {
  return cloudPauseActive(readCloudSyncState());
}

function recordCloudResult(result) {
  if (!result || typeof result !== 'object') return;
  const current = readCloudSyncState();
  if (result.terminalFailure) {
    const paused = cloudPauseState(current, result);
    writeCloudSyncState(paused);
    updateCloudHealth({
      accessPaused: true,
      pauseCode: paused.pauseCode,
      pauseMessage: paused.pauseMessage,
      dataExpiresAt: paused.dataExpiresAt,
      nextEntitlementCheckAt: paused.nextEntitlementCheckAt,
      lastFailureAt: new Date().toISOString(),
    });
  } else if (result.ok && current.accessPaused) {
    writeCloudSyncState(clearCloudPause(current));
    updateCloudHealth({
      accessPaused: false,
      pauseCode: null,
      pauseMessage: null,
      dataExpiresAt: null,
      nextEntitlementCheckAt: null,
      lastSuccessAt: new Date().toISOString(),
    });
  }
}

function normalizeQueueEntry(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.payload && typeof value.payload === 'object') return value;
  // Backwards compatibility with v0.5 queues that stored raw payloads.
  return { payload: value, attempts: 0, nextAttemptAt: Date.now(), firstFailedAt: new Date().toISOString() };
}

function readCloudQueueEntries() {
  if (!existsSync(CLOUD_QUEUE_FILE)) return [];
  const entries = [];
  try {
    for (const line of readFileSync(CLOUD_QUEUE_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = normalizeQueueEntry(JSON.parse(line));
        if (entry) entries.push(entry);
      } catch {
        // Corrupt lines are discarded without affecting valid metadata.
      }
    }
  } catch {}
  return entries;
}

function queueEncodedBytes(entries) {
  return entries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
}

function writeCloudQueueEntries(entries) {
  const temporary = `${CLOUD_QUEUE_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, entries.length ? entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n' : '');
  renameSync(temporary, CLOUD_QUEUE_FILE);
}

function readCloudHealth() {
  try { return JSON.parse(readFileSync(CLOUD_HEALTH_FILE, 'utf8')); } catch { return { pending: pendingCloudSyncCount(), dropped: 0 }; }
}

function updateCloudHealth({
  pending, lastAttemptAt, lastSuccessAt, lastFailureAt, droppedDelta = 0,
  accessPaused, pauseCode, pauseMessage, dataExpiresAt, nextEntitlementCheckAt,
}) {
  try {
    const current = readCloudHealth();
    const next = {
      pending: Number(pending ?? current.pending ?? 0),
      dropped: Number(current.dropped || 0) + Number(droppedDelta || 0),
      lastAttemptAt: lastAttemptAt ?? current.lastAttemptAt ?? null,
      lastSuccessAt: lastSuccessAt ?? current.lastSuccessAt ?? null,
      lastFailureAt: lastFailureAt ?? current.lastFailureAt ?? null,
      accessPaused: accessPaused ?? current.accessPaused ?? false,
      pauseCode: pauseCode !== undefined ? pauseCode : current.pauseCode ?? null,
      pauseMessage: pauseMessage !== undefined ? pauseMessage : current.pauseMessage ?? null,
      dataExpiresAt: dataExpiresAt !== undefined ? dataExpiresAt : current.dataExpiresAt ?? null,
      nextEntitlementCheckAt: nextEntitlementCheckAt !== undefined ? nextEntitlementCheckAt : current.nextEntitlementCheckAt ?? null,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(CLOUD_HEALTH_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

function pendingCloudSyncCount() {
  return readCloudQueueEntries().length;
}
