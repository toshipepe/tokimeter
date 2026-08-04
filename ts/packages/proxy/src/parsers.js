/**
 * Tokimeter — local usage log parsers.
 *
 * Pure file→events readers for Claude Code transcripts (~/.claude/projects)
 * and Codex rollout session logs (~/.codex/sessions). No proxy, no network,
 * no writes — safe to use from the zero-setup report and covered by fixture
 * tests in test/parsers.test.js.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

const { getPricingSource, priceCall, getPrice } = await importCorePricing();

// Parse one JSONL line into a plain object, tolerating BOMs and junk.
// Returns null for blank lines, malformed JSON, and non-object values
// (a bare `null`/number/string is valid JSON but never a log record).
function parseRecord(rawLine) {
  const line = rawLine.replace(/^\uFEFF/, '').trim();
  if (!line) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

// Newer Claude transcripts nest cache-write tokens under usage.cache_creation
// ({ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}); older ones only
// have the flat cache_creation_input_tokens. Prefer the flat field, fall back
// to summing the nested buckets.
function claudeCacheCreationTokens(usage) {
  const flat = Number(usage.cache_creation_input_tokens);
  if (Number.isFinite(flat) && flat > 0) return flat;
  const nested = usage.cache_creation;
  if (nested && typeof nested === 'object') {
    let sum = 0;
    for (const value of Object.values(nested)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) sum += n;
    }
    if (sum > 0) return sum;
  }
  return Math.max(0, flat || 0);
}

export function readClaudeUsageEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const seenMessageIds = new Set();
  const lines = text.split(/\r?\n/);
  const fileSessionId = basename(filePath, '.jsonl');

  for (let i = 0; i < lines.length; i++) {
    const obj = parseRecord(lines[i]);
    if (!obj) continue;

    if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') continue;
    const message = obj.message;
    // '<synthetic>' marks locally generated placeholder turns (errors,
    // interruptions) that never hit the API — never price them.
    if (message.model === '<synthetic>') continue;
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
    if (!usage) continue;

    const timestamp = Date.parse(obj.timestamp || '') || Date.now();
    if (sinceMs && timestamp < sinceMs) continue;

    const messageId = message.id || obj.requestId || obj.uuid || `${filePath}:${i + 1}`;
    if (seenMessageIds.has(messageId)) continue;
    seenMessageIds.add(messageId);

    const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
    const cacheCreationTokens = claudeCacheCreationTokens(usage);
    const cachedTokens = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
    const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);

    if (inputTokens + cacheCreationTokens + cachedTokens + outputTokens === 0) continue;

    const model = message.model || 'claude';
    const cwd = obj.cwd || '';
    const sessionId = obj.sessionId || obj.session_id || fileSessionId;
    events.push({
      timestamp,
      provider: 'anthropic',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      latencyMs: 0,
      success: obj.isApiErrorMessage !== true,
      tool: 'claude-code',
      source: 'claude-transcript-usage',
      confidence: 'exact',
      pricingConfidence: getPricingSource(model).confidence,
      cwd: cwd || undefined,
      sessionId,
      externalId: `claude-transcript:${messageId}`,
      note: 'Imported from Claude Code local transcript usage. Cost is the API-equivalent estimate; on a Claude subscription this is notional, not billed.',
      // Subagent (Task tool) turns are logged in the same transcript with
      // isSidechain: true — the basis for director/worker attribution.
      ...(obj.isSidechain === true ? { role: 'worker' } : {}),
      // Newer Claude Code splits each subagent into its own file, every line
      // carrying `agentId`. It's an internal handle (never displayed), used
      // only to join a worker turn to the Task call that named its type.
      ...(obj.agentId ? { agentId: String(obj.agentId) } : {}),
    });
  }

  return events;
}

// Agent roster + skill usage from a Claude main transcript. Findings (verified
// 2026-07-09 against real transcripts, documented here per BUILD_PLAN 2.1):
//   • Agent type/name lives on `Task`/`Agent` tool_use blocks as
//     input.subagent_type (e.g. "general-purpose", "Explore", "Plan"),
//     input.description (the human label), and input.model.
//   • That tool_use's tool_result text contains `agentId: <id>`, which joins
//     to the subagent's own file (subagents/agent-<id>.jsonl) where the token
//     usage lives. The agentId is an internal handle — used only as a join
//     key, never surfaced to the user (only the type/description are).
//   • Skill invocations are `Skill` tool_use blocks with input.skill.
//   • Older inline format: sidechain turns sit in the main transcript with
//     isSidechain:true and no agentId — attributable as "worker" but without
//     a type. This reader simply yields no roster entry for those.
// Returns { sessionId, agents:[{agentId,subagentType,description,model}], skills:[{skill,count}] }.
export function readClaudeAgentActivity(filePath) {
  let text = '';
  try { text = readFileSync(filePath, 'utf8'); } catch { return { sessionId: null, agents: [], skills: [] }; }

  const tasksById = new Map();   // tool_use id -> { subagentType, description, model }
  const agentIdFor = new Map();  // tool_use id -> agentId (from its result)
  const skillCounts = new Map();
  let sessionId = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) {
        const inp = b.input || {};
        tasksById.set(b.id, {
          subagentType: inp.subagent_type || inp.subagentType || 'unknown',
          description: inp.description || null,
          model: inp.model || null,
        });
      } else if (b.type === 'tool_use' && b.name === 'Skill') {
        const skill = (b.input || {}).skill;
        if (skill) skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
      } else if (b.type === 'tool_result' && b.tool_use_id && tasksById.has(b.tool_use_id)) {
        let t = b.content;
        if (Array.isArray(t)) t = t.map((x) => (x && x.text) || '').join(' ');
        const m = /agentId:\s*(\w+)/.exec(String(t || ''));
        if (m) agentIdFor.set(b.tool_use_id, m[1]);
      }
    }
  }

  const agents = [];
  for (const [id, meta] of tasksById) {
    agents.push({ agentId: agentIdFor.get(id) || null, ...meta });
  }
  const skills = [...skillCounts.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count);

  return { sessionId, agents, skills };
}

export function readCodexTokenEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  const sessionId = basename(filePath, '.jsonl');
  let model = 'codex-chatgpt';
  let effort = '';
  let cwd = '';

  for (let i = 0; i < lines.length; i++) {
    const obj = parseRecord(lines[i]);
    if (!obj) continue;

    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
      // cwd for turns before the first turn_context record.
      cwd = cwd || (typeof obj.payload.cwd === 'string' ? obj.payload.cwd : '');
      continue;
    }

    if (obj.type === 'turn_context' && obj.payload && typeof obj.payload === 'object') {
      model = obj.payload.model || model;
      effort = obj.payload.effort || effort;
      cwd = obj.payload.cwd || cwd;
      continue;
    }

    if (obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count') continue;

    const info = obj.payload.info && typeof obj.payload.info === 'object' ? obj.payload.info : {};
    const usage = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
    const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
    const cachedTokens = Math.max(0, Number(usage.cached_input_tokens) || 0);
    const reasoningTokens = Math.max(0, Number(usage.reasoning_output_tokens) || 0);

    if (inputTokens + outputTokens + cachedTokens === 0) continue;

    const timestamp = Date.parse(obj.timestamp || '') || Date.now();
    if (sinceMs && timestamp < sinceMs) continue;

    events.push({
      timestamp,
      provider: 'openai',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      latencyMs: 0,
      success: true,
      tool: 'codex',
      source: 'codex-rollout-token-count',
      confidence: 'imported',
      pricingConfidence: getPricingSource(model).confidence,
      effort: effort || undefined,
      cwd: cwd || undefined,
      sessionId,
      externalId: `codex-rollout:${filePath}:${i + 1}`,
      note: `Imported from Codex rollout token_count metadata${effort ? ` (${effort} effort)` : ''}${cwd ? ` for ${cwd}` : ''}.`,
    });
  }

  return events;
}

/**
 * Read the vendor rate-limit snapshots Codex embeds in token_count events.
 * Each snapshot carries used_percent / window_minutes / resets_at (epoch
 * seconds) in primary / secondary slots. The slot does not identify the
 * duration, so callers must use window_minutes. Returns snapshots in file
 * order; callers usually want the last one (most recent).
 */
export function readCodexRateLimitSnapshots(filePath) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const snapshots = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const obj = parseRecord(rawLine);
    if (!obj || obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count') continue;
    const limits = obj.payload.rate_limits;
    if (!limits || typeof limits !== 'object') continue;

    const windowOf = raw => {
      if (!raw || typeof raw !== 'object') return null;
      const usedPercent = Number(raw.used_percent);
      const windowMinutes = Number(raw.window_minutes);
      const resetsAt = Number(raw.resets_at);
      if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes)) return null;
      return {
        usedPercent,
        windowMinutes,
        resetsAtMs: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null,
      };
    };

    const primary = windowOf(limits.primary);
    const secondary = windowOf(limits.secondary);
    if (!primary && !secondary) continue;

    snapshots.push({
      timestamp: Date.parse(obj.timestamp || '') || null,
      planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      primary,
      secondary,
    });
  }

  return snapshots;
}

/**
 * Classify Codex vendor windows by their recorded duration, not by the
 * primary / secondary slot they happened to occupy. Unknown durations keep a
 * literal duration-derived label and no typed kind, so callers can display
 * the evidence without inventing quota semantics.
 */
export function classifyCodexRateLimitWindows(snapshot) {
  const durationLabel = (minutes) => {
    if (Number.isInteger(minutes) && minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (Number.isInteger(minutes) && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  };

  return [snapshot?.primary, snapshot?.secondary]
    .filter((window) => window && Number.isFinite(window.windowMinutes) && window.windowMinutes > 0)
    .map((window) => {
      if (window.windowMinutes === 300) {
        return { window, kind: '5h', label: '5h window' };
      }
      if (window.windowMinutes === 10080) {
        return { window, kind: 'weekly', label: 'Weekly' };
      }
      return { window, kind: null, label: `${durationLabel(window.windowMinutes)} window` };
    })
    .sort((a, b) => a.window.windowMinutes - b.window.windowMinutes);
}

// List recent Codex rollout .jsonl files under a sessions dir, newest first.
// Shared by the CLI limits view and the proxy's snapshot sync.
export function recentCodexRolloutFiles(codexSessionsDir, { limit = 8, maxAgeMs = 2 * 86400 * 1000 } = {}) {
  if (!codexSessionsDir) return [];
  const cutoff = Date.now() - maxAgeMs;
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) found.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* ignore unreadable */ }
      }
    }
  };
  walk(codexSessionsDir);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((f) => f.path);
}

// Freshest Codex vendor rate-limit snapshot across recent rollouts, as
// { planType, primary, secondary } where each window is { usedPercent,
// windowMinutes, resetsAtMs }. Windows whose reset time has passed are dropped
// (stale). Returns null when nothing fresh (< maxAgeMs) is available. This is
// the vendor's own counter — evidence, not an estimate.
export function latestCodexVendorSnapshot(codexSessionsDir, { maxAgeMs = 86400 * 1000 } = {}) {
  let latest = null;
  for (const file of recentCodexRolloutFiles(codexSessionsDir, { limit: 8, maxAgeMs: 2 * 86400 * 1000 })) {
    for (const snap of readCodexRateLimitSnapshots(file)) {
      if (snap.timestamp && (!latest || snap.timestamp > latest.timestamp)) latest = snap;
    }
  }
  if (!latest || Date.now() - latest.timestamp > maxAgeMs) return null;
  const live = (w) => (w && (!w.resetsAtMs || w.resetsAtMs > Date.now()) ? w : null);
  const primary = live(latest.primary);
  const secondary = live(latest.secondary);
  if (!primary && !secondary) return null;
  return { timestamp: latest.timestamp, planType: latest.planType, primary, secondary };
}

/**
 * Parse Grok Build's unified log (~/.grok/logs/unified.jsonl) for per-turn
 * usage. Grok Build (xAI's terminal coding agent) writes one
 * `shell.turn.inference_done` record per model turn with exact token counts:
 *   {"ts":"...","sid":"<session>","msg":"shell.turn.inference_done",
 *    "ctx":{"prompt_tokens":N,"cached_prompt_tokens":N,"completion_tokens":N,
 *           "reasoning_tokens":N,...}}
 * The model/cwd are not on the usage record; pass sessionMeta (sid → {model,
 * cwd}) built by readGrokSessionMeta() to enrich them.
 */
export function readGrokUsageEvents(filePath, { sinceMs = 0, sessionMeta = {} } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const obj = parseRecord(lines[i]);
    if (!obj || obj.msg !== 'shell.turn.inference_done') continue;
    const ctx = obj.ctx && typeof obj.ctx === 'object' ? obj.ctx : {};

    const inputTokens = Math.max(0, Number(ctx.prompt_tokens) || 0);
    const cachedTokens = Math.max(0, Number(ctx.cached_prompt_tokens) || 0);
    const outputTokens = Math.max(0, Number(ctx.completion_tokens) || 0);
    const reasoningTokens = Math.max(0, Number(ctx.reasoning_tokens) || 0);
    if (inputTokens + outputTokens + cachedTokens === 0) continue;

    const timestamp = Date.parse(obj.timestamp || obj.ts || '') || Date.now();
    if (sinceMs && timestamp < sinceMs) continue;

    const sid = typeof obj.sid === 'string' ? obj.sid : '';
    const meta = (sid && sessionMeta[sid]) || {};
    const model = meta.model || 'grok-build';

    events.push({
      timestamp,
      provider: 'xai',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      latencyMs: Math.max(0, Number(ctx.model_elapsed_ms) || 0),
      success: true,
      tool: 'grok',
      source: 'grok-unified-log',
      confidence: 'imported',
      pricingConfidence: getPricingSource(model).confidence,
      cwd: meta.cwd || undefined,
      sessionId: sid || undefined,
      externalId: `grok-unified:${sid || basename(filePath)}:${i + 1}`,
      note: 'Imported from Grok Build unified log inference metadata. Cost is the API-equivalent estimate; on an X Premium/SuperGrok subscription this is notional, not billed.',
    });
  }

  return events;
}

/**
 * Build sid → { model, cwd } from Grok Build's session summaries
 * (~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/summary.json).
 * current_model_id is the last model used in the session — turns before a
 * mid-session model switch inherit it, which is the best available signal.
 */
export function readGrokSessionMeta(sessionsDir) {
  const meta = {};
  let cwdDirs = [];
  try {
    cwdDirs = readdirSync(sessionsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    return meta;
  }

  for (const cwdDir of cwdDirs) {
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(join(sessionsDir, cwdDir.name), { withFileTypes: true }).filter(e => e.isDirectory());
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      try {
        const summary = JSON.parse(readFileSync(join(sessionsDir, cwdDir.name, sessionDir.name, 'summary.json'), 'utf8'));
        if (!summary || typeof summary !== 'object') continue;
        const sid = summary.info?.id || sessionDir.name;
        meta[sid] = {
          model: typeof summary.current_model_id === 'string' ? summary.current_model_id : '',
          cwd: typeof summary.info?.cwd === 'string' ? summary.info.cwd : '',
        };
      } catch {
        // Unreadable/partial summary — usage still imports with defaults.
      }
    }
  }

  return meta;
}

// "2.8k" → 2800, "27" → 27, "1.2m" → 1200000. Aider's history rounds token
// counts this way, so imported aider events are approximations by design.
function parseAiderTokenCount(text) {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(String(text).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return 0;
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(n * mult);
}

/**
 * Parse an aider chat history file (.aider.chat.history.md). Aider announces
 * usage after each message as lines like:
 *   > Tokens: 2.8k sent, 27 received. Cost: $0.0029 message, $0.0029 session.
 * with the active model announced as "> Model: gpt-4o with diff edit format"
 * (older) or "> Main model: openai/gpt-5 with diff edit format" (newer), and
 * sessions delimited by "# aider chat started at 2026-07-08 10:11:12".
 *
 * Only these metadata lines are read; the surrounding prompt/response content
 * is never extracted. Timestamps are approximated from the session header
 * (aider does not timestamp individual messages).
 */
export function readAiderHistoryEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  let sessionStart = 0;
  let sessionIndex = 0;
  let messageIndex = 0;
  let model = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const started = /^#+\s*aider chat started at\s+(.+)$/i.exec(line);
    if (started) {
      sessionStart = Date.parse(started[1].trim()) || sessionStart || 0;
      sessionIndex++;
      messageIndex = 0;
      continue;
    }

    const modelLine = /^>?\s*(?:Main model|Model):\s*([^\s]+)/i.exec(line);
    if (modelLine) {
      model = modelLine[1].trim();
      continue;
    }

    const usage = /^>?\s*Tokens:\s*([\d.]+\s*[km]?)\s*sent,\s*([\d.]+\s*[km]?)\s*received\.?(?:\s*Cost:\s*\$([\d.]+)\s*message)?/i.exec(line);
    if (!usage) continue;

    const inputTokens = parseAiderTokenCount(usage[1]);
    const outputTokens = parseAiderTokenCount(usage[2]);
    if (inputTokens + outputTokens === 0) continue;
    const messageCost = usage[3] !== undefined ? Number(usage[3]) : null;

    messageIndex++;
    // Approximate: session start plus a minute per message keeps ordering
    // and daily binning sane without inventing precision aider doesn't log.
    const timestamp = (sessionStart || Date.now()) + messageIndex * 60 * 1000;
    if (sinceMs && timestamp < sinceMs) continue;

    const cleanModel = model || 'unknown';
    const provider = /claude|anthropic/i.test(cleanModel) ? 'anthropic'
      : /gemini/i.test(cleanModel) ? 'google'
        : 'openai';

    events.push({
      timestamp,
      provider,
      model: cleanModel,
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      latencyMs: 0,
      success: true,
      tool: 'aider',
      source: 'aider-history',
      confidence: 'estimated',
      pricingConfidence: messageCost !== null && Number.isFinite(messageCost)
        ? 'reported'
        : getPricingSource(cleanModel).confidence,
      ...(messageCost !== null && Number.isFinite(messageCost) ? { totalCost: messageCost } : {}),
      sessionId: `aider:${basename(filePath)}:${sessionIndex}`,
      externalId: `aider-history:${filePath}:${i + 1}`,
      note: 'Imported from aider chat history token/cost lines. Token counts are aider\'s rounded values; message timestamps approximated from the session start.',
    });
  }

  return events;
}

/**
 * Sanity-check that a local log file still matches a shape this version of
 * Tokimeter understands. Used by `tokimeter doctor` to warn about schema
 * drift after Claude Code / Codex updates, instead of silently undercounting.
 *
 * kind: 'claude' | 'codex'. Returns { lines, records, malformed,
 * truncatedTail, usageCandidates, usageExtracted, ok, reason }.
 */
export function analyzeLogFileFormat(filePath, kind) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { lines: 0, records: 0, malformed: 0, truncatedTail: false, usageCandidates: 0, usageExtracted: 0, ok: false, reason: 'unreadable file' };
  }

  const rawLines = text.split(/\r?\n/).filter(line => line.trim());
  let records = 0;
  let malformed = 0;
  let truncatedTail = false;
  let usageCandidates = 0;
  let usageExtracted = 0;

  const hasPositiveNumber = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(v => Number.isFinite(Number(v)) && Number(v) > 0);
  };

  for (let i = 0; i < rawLines.length; i++) {
    let parsed;
    try {
      parsed = JSON.parse(rawLines[i].replace(/^\uFEFF/, '').trim());
    } catch {
      // A malformed final line is almost always a partial write from a live
      // session, not schema drift — track it separately.
      if (i === rawLines.length - 1) truncatedTail = true;
      else malformed++;
      continue;
    }
    // Valid JSON that is not an object is odd but parseable — not drift.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed;
    records++;

    if (kind === 'claude') {
      if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') continue;
      if (obj.message.model === '<synthetic>') continue;
      const usage = obj.message.usage;
      if (!usage || typeof usage !== 'object' || !hasPositiveNumber(usage)) continue;
      usageCandidates++;
      const known = (Number(usage.input_tokens) || 0) + claudeCacheCreationTokens(usage)
        + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.output_tokens) || 0);
      if (known > 0) usageExtracted++;
    } else if (kind === 'codex') {
      if (obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count') continue;
      const info = obj.payload.info;
      if (!info || typeof info !== 'object' || (!hasPositiveNumber(info.last_token_usage) && !hasPositiveNumber(info.total_token_usage))) continue;
      usageCandidates++;
      const usage = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
      const known = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) + (Number(usage.cached_input_tokens) || 0);
      if (known > 0) usageExtracted++;
    } else if (kind === 'openhuman') {
      if (!obj.usage || typeof obj.usage !== 'object') continue;
      usageCandidates++;
      if (openHumanCostRecordToEvent(obj)) usageExtracted++;
    }
  }

  let ok = true;
  let reason = '';
  const parseable = records + malformed;
  if (parseable > 0 && malformed / parseable > 0.2) {
    ok = false;
    reason = `${malformed} of ${parseable} lines are not valid JSON records`;
  } else if (usageCandidates > 0 && usageExtracted === 0) {
    ok = false;
    reason = 'usage data present but not in a recognized shape';
  } else if (rawLines.length > 0 && records === 0) {
    ok = false;
    reason = 'no recognizable records';
  }

  return { lines: rawLines.length, records, malformed, truncatedTail, usageCandidates, usageExtracted, ok, reason };
}

// ─── OpenHuman cost ledger (~/.openhuman/.../workspace/state/costs.jsonl) ──
// OpenHuman's append-only ledger contains numeric usage/cost metadata. Memory
// trees, run journals, transcripts, configuration, and OAuth files are never
// read by this integration.

const OPENHUMAN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nonNegativeNumber(value, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function openHumanProvider(model) {
  const slash = model.indexOf('/');
  if (slash <= 0) return 'openhuman';
  const prefix = model.slice(0, slash).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(prefix) ? prefix : 'openhuman';
}

export function openHumanCostRecordToEvent(record, { sinceMs = 0 } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.id !== 'string' || !OPENHUMAN_UUID.test(record.id)) return null;
  const usage = record.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;

  const model = typeof usage.model === 'string' ? usage.model.trim() : '';
  const timestamp = typeof usage.timestamp === 'string' ? Date.parse(usage.timestamp) : NaN;
  if (!model || !Number.isFinite(timestamp) || timestamp <= 0 || (sinceMs && timestamp < sinceMs)) return null;

  const inputTokens = nonNegativeNumber(usage.input_tokens, { integer: true });
  const outputTokens = nonNegativeNumber(usage.output_tokens, { integer: true });
  const cachedTokens = nonNegativeNumber(usage.cached_input_tokens, { integer: true });
  const cacheCreationTokens = nonNegativeNumber(usage.cache_creation_tokens, { integer: true });
  const reasoningTokens = nonNegativeNumber(usage.reasoning_tokens, { integer: true });
  const totalTokens = nonNegativeNumber(usage.total_tokens, { integer: true });
  const cost = nonNegativeNumber(usage.cost_usd);
  if ([inputTokens, outputTokens, cachedTokens, cacheCreationTokens, reasoningTokens, totalTokens, cost].includes(null)) return null;
  if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens + reasoningTokens + cost === 0) return null;

  if (usage.cost_source !== 'provider_charged' && usage.cost_source !== 'estimated') return null;
  const costSource = usage.cost_source;
  const sessionId = typeof record.session_id === 'string' && OPENHUMAN_UUID.test(record.session_id)
    ? record.session_id
    : '';
  return {
    timestamp,
    provider: openHumanProvider(model),
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    reasoningTokens,
    // OpenHuman normalizes cached input as a subset of input_tokens.
    cachedDisjoint: false,
    totalCost: cost,
    pricingConfidence: cost > 0
      ? (costSource === 'provider_charged' ? 'reported' : 'estimated')
      : getPricingSource(model).confidence,
    costSource: cost > 0 && costSource === 'provider_charged' ? 'provider_charged' : 'estimated',
    tool: 'openhuman',
    source: 'openhuman-cost-record',
    confidence: 'exact',
    sessionId,
    externalId: `openhuman-cost:${record.id.toLowerCase()}`,
  };
}

export function readOpenHumanCostEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const event = openHumanCostRecordToEvent(parseRecord(rawLine), { sinceMs });
    if (!event || seen.has(event.externalId)) continue;
    seen.add(event.externalId);
    events.push(event);
  }
  return events;
}

function markerString(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^\\s*${escaped}\\s*=\\s*(["'])([^"'\\r\\n]*)\\1\\s*(?:#.*)?$`, 'm'));
  return match ? match[2].trim() : '';
}

// Return only workspace directories. The active user id is used for local
// discovery and is never copied into an event. Reject traversal before path
// construction and verify the resolved path remains under users/.
export function openHumanWorkspaceCandidates({
  homeDir,
  explicitWorkspace = '',
  activeUserText = '',
  activeWorkspaceText = '',
} = {}) {
  const home = resolve(String(homeDir || ''));
  const root = join(home, '.openhuman');
  const usersRoot = join(root, 'users');
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const path = resolve(String(value));
    if (!candidates.includes(path)) candidates.push(path);
  };

  add(explicitWorkspace);
  const userId = markerString(activeUserText, 'user_id');
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId) && userId !== '.' && userId !== '..') {
    const workspace = resolve(usersRoot, userId, 'workspace');
    const rel = relative(usersRoot, workspace);
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) add(workspace);
  }
  const activeWorkspace = markerString(activeWorkspaceText, 'config_dir');
  if (activeWorkspace) add(activeWorkspace);
  add(join(usersRoot, 'local', 'workspace'));
  add(join(root, 'workspace'));
  return candidates;
}

// ─── Hermes session rows → usage events ─────────────────────────────────────
// Pure mapping (testable without SQLite); the CLI reads ~/.hermes/state.db
// rows and passes them here. One event per session — Hermes stores totals,
// not per-turn usage. source='subagent' rows are delegated workers; their
// parent_session_id links back to the directing session.

const HERMES_SESSION_COLUMN_DEFAULTS = {
  id: "''",
  source: "''",
  model: "''",
  input_tokens: '0',
  output_tokens: '0',
  cache_read_tokens: '0',
  cache_write_tokens: '0',
  reasoning_tokens: '0',
  actual_cost_usd: 'NULL',
  billing_provider: 'NULL',
  cwd: 'NULL',
  started_at: '0',
  ended_at: 'NULL',
  parent_session_id: 'NULL',
  title: 'NULL',
  api_call_count: '0',
  git_branch: 'NULL',
  git_repo_root: 'NULL',
};

// Hermes evolves state.db in place. Build the SELECT from PRAGMA table_info
// rather than treating optional attribution columns as required. Every output
// row keeps a stable shape so the mapping below remains version-independent.
export function buildHermesSessionQuery(availableColumns = []) {
  const available = new Set(Array.from(availableColumns, (column) => String(column)));
  const select = Object.entries(HERMES_SESSION_COLUMN_DEFAULTS).map(([column, fallback]) =>
    available.has(column) ? `"${column}"` : `${fallback} AS "${column}"`);
  const usageColumns = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
  ].filter((column) => available.has(column));
  const usage = usageColumns.length
    ? usageColumns.map((column) => `COALESCE("${column}", 0)`).join(' + ')
    : '0';
  return `SELECT ${select.join(', ')} FROM sessions WHERE ${usage} > 0`;
}

function hermesProviderFor(billingProvider, model) {
  const bp = String(billingProvider || '');
  if (bp === 'zai') return 'zai';
  if (bp.startsWith('xai')) return 'xai';
  const m = String(model || '').toLowerCase();
  if (m.startsWith('glm')) return 'zai';
  if (m.startsWith('grok') || m.startsWith('composer')) return 'xai';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o')) return 'openai';
  return 'unknown';
}

export function hermesRowsToEvents(rows, { sinceMs = 0 } = {}) {
  const events = [];
  for (const row of rows || []) {
    const startedMs = (Number(row.started_at) || 0) * 1000;
    const endedMs = (Number(row.ended_at) || 0) * 1000;
    const timestamp = endedMs || startedMs || Date.now();
    if (sinceMs && timestamp < sinceMs) continue;

    const model = String(row.model || 'unknown');
    const actualCost = Number(row.actual_cost_usd) || 0;
    const isSubagent = String(row.source || '') === 'subagent';
    const billingProvider = String(row.billing_provider || '').trim().toLowerCase();
    events.push({
      timestamp,
      provider: hermesProviderFor(billingProvider, model),
      model,
      inputTokens: Math.max(0, Number(row.input_tokens) || 0),
      outputTokens: Math.max(0, Number(row.output_tokens) || 0),
      cachedTokens: Math.max(0, Number(row.cache_read_tokens) || 0),
      cacheCreationTokens: Math.max(0, Number(row.cache_write_tokens) || 0),
      reasoningTokens: Math.max(0, Number(row.reasoning_tokens) || 0),
      cachedDisjoint: true,
      ended: Boolean(endedMs),
      latencyMs: 0,
      success: true,
      tool: 'hermes',
      source: 'hermes-state-db',
      confidence: 'imported',
      pricingConfidence: actualCost > 0 ? 'reported' : getPricingSource(model).confidence,
      ...(billingProvider ? { billingProvider } : {}),
      ...(billingProvider.startsWith('xai') ? { accessPath: 'xAI OAuth (subscription)' } : {}),
      ...(actualCost > 0 ? { totalCost: actualCost } : {}),
      effort: row.source ? String(row.source) : undefined,
      // Hermes records the git repo root per session — steadier project
      // attribution than a transient cwd when both are present.
      cwd: row.git_repo_root ? String(row.git_repo_root) : (row.cwd ? String(row.cwd) : undefined),
      sessionId: String(row.id || ''),
      externalId: `hermes-session:${row.id}`,
      note: `Imported from Hermes local session totals (${row.source || 'unknown'} session). Session-level aggregate, not per-turn.`,
      ...(isSubagent ? { role: 'worker' } : {}),
      ...(row.parent_session_id ? { parentSessionId: String(row.parent_session_id) } : {}),
      ...(row.title ? { sessionTitle: String(row.title) } : {}),
      ...(Number(row.api_call_count) > 0 ? { apiCallCount: Number(row.api_call_count) } : {}),
      ...(row.git_branch ? { gitBranch: String(row.git_branch) } : {}),
    });
  }
  return events;
}

// ─── Delegation report (director vs worker economics) ───────────────────────
// Attribution sources, per tool (see docs/BUILD_PLAN.md coverage matrix):
//   claude-code — per-turn: events with role='worker' are subagent turns;
//     the rest of the same session is the director side.
//   hermes — per-session: role='worker' sessions link to their director via
//     parentSessionId; the parent session's model names the director.
//   codex / grok — no role markers known: reported as attribution 'none'
//     rather than guessed.
// Events must already carry totalCost (the collector prices them).

export function buildDelegationReport(events) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const bucket = () => ({ cost: 0, calls: 0, outputTokens: 0 });
  const add = (b, e) => {
    b.cost += e.totalCost || 0;
    b.calls += 1;
    b.outputTokens += e.outputTokens || 0;
  };
  const finish = (b) => ({ ...b, cost: round2(b.cost) });

  // Advisor counterfactuals: re-price a turn's exact tokens at a *different*
  // model, honestly. Returns null when either model's pricing is a fallback
  // (unknown) — we never guess. Cache accounting mirrors the collector:
  // anthropic and any cachedDisjoint tool bill cache read separately from
  // input, so cachedIncludedInInput is false for them.
  const priced = (model) => model && getPrice(model) != null
    && getPricingSource(model).confidence !== 'fallback';
  const disjoint = (e) => e.provider === 'anthropic' || e.cachedDisjoint === true;
  const repriceAt = (model, e) => {
    if (!priced(model) || !priced(e.model)) return null;
    return priceCall(model, e.inputTokens || 0, e.outputTokens || 0, e.cachedTokens || 0,
      e.cacheCreationTokens || 0, { cachedIncludedInInput: !disjoint(e) }).totalCost;
  };
  const blendedRate = (model) => {
    const p = getPrice(model);
    return p ? (Number(p.input) || 0) + (Number(p.output) || 0) : Infinity;
  };
  // Small, low-context turns — the kind that could be delegated. Same
  // thresholds as buildInsights' small-turns-on-premium heuristic.
  const looksLikeGrunt = (e) => (e.inputTokens || 0) < 2000 && (e.outputTokens || 0) < 400
    && (e.cachedTokens || 0) + (e.cacheCreationTokens || 0) < 20000;

  const tools = {};

  // Claude Code: per-turn sidechain attribution within each session.
  {
    const claude = events.filter((e) => e.tool === 'claude-code');
    const sessions = new Map();
    for (const e of claude) {
      const key = e.sessionId || '(none)';
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push(e);
    }
    const director = bucket();
    const worker = bucket();
    const workerModels = new Map();
    const pairs = new Map();
    let delegationSessions = 0;
    // Advisor accumulators.
    let wActual = 0, wAtDirector = 0, wPriced = 0, wSkipped = 0;
    let gTurns = 0, gActual = 0, gAtWorker = 0;
    for (const list of sessions.values()) {
      const workers = list.filter((e) => e.role === 'worker');
      if (!workers.length) continue;
      delegationSessions += 1;
      const main = list.filter((e) => e.role !== 'worker');
      // The director model is the session's dominant main-thread model.
      const byModel = new Map();
      for (const e of main) byModel.set(e.model, (byModel.get(e.model) || 0) + (e.totalCost || 0));
      const directorModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '(unknown)';
      // Cheapest model actually used as a worker in this session.
      const cheapestWorker = [...new Set(workers.map((e) => e.model))]
        .sort((a, b) => blendedRate(a) - blendedRate(b))[0];
      for (const e of main) {
        add(director, e);
        // Director grunt work re-priced at the session's cheapest worker model.
        if (looksLikeGrunt(e)) {
          const alt = repriceAt(cheapestWorker, e);
          if (alt != null) { gTurns += 1; gActual += e.totalCost || 0; gAtWorker += alt; }
        }
      }
      for (const e of workers) {
        add(worker, e);
        if (!workerModels.has(e.model)) workerModels.set(e.model, bucket());
        add(workerModels.get(e.model), e);
        const pk = `${directorModel} → ${e.model}`;
        if (!pairs.has(pk)) pairs.set(pk, bucket());
        add(pairs.get(pk), e);
        // Worker turn re-priced at the director model.
        const alt = repriceAt(directorModel, e);
        if (alt == null) { wSkipped += 1; continue; }
        wPriced += 1; wActual += e.totalCost || 0; wAtDirector += alt;
      }
    }
    tools['claude-code'] = {
      attribution: 'per-turn',
      delegationSessions,
      director: finish(director),
      worker: finish(worker),
      workerModels: [...workerModels.entries()].map(([model, b]) => ({ model, ...finish(b) })).sort((a, b) => b.cost - a.cost),
      pairs: [...pairs.entries()].map(([pair, b]) => ({ pair, ...finish(b) })).sort((a, b) => b.cost - a.cost),
      advisor: {
        workerVsDirector: wPriced > 0
          ? { workersPriced: wPriced, workersSkipped: wSkipped, actualCost: round2(wActual), atDirectorCost: round2(wAtDirector), delta: round2(wAtDirector - wActual) }
          : null,
        directorGrunt: gTurns > 0
          ? { turns: gTurns, actualCost: round2(gActual), atCheapestWorkerCost: round2(gAtWorker), delta: round2(gActual - gAtWorker) }
          : null,
      },
    };
  }

  // Hermes: per-session attribution via parent_session_id.
  {
    const hermes = events.filter((e) => e.tool === 'hermes');
    const byId = new Map(hermes.map((e) => [e.sessionId, e]));
    const director = bucket();
    const worker = bucket();
    const workerModels = new Map();
    const pairs = new Map();
    const directorIds = new Set();
    let wActual = 0, wAtDirector = 0, wPriced = 0, wSkipped = 0;
    for (const e of hermes) {
      if (e.role !== 'worker') continue;
      add(worker, e);
      if (!workerModels.has(e.model)) workerModels.set(e.model, bucket());
      add(workerModels.get(e.model), e);
      const parent = e.parentSessionId ? byId.get(e.parentSessionId) : null;
      const directorModel = parent ? parent.model : '(unknown parent)';
      const pk = `${directorModel} → ${e.model}`;
      if (!pairs.has(pk)) pairs.set(pk, bucket());
      add(pairs.get(pk), e);
      if (parent && !directorIds.has(parent.sessionId)) {
        directorIds.add(parent.sessionId);
        add(director, parent);
      }
      // Worker session re-priced at the directing session's model.
      const alt = parent ? repriceAt(directorModel, e) : null;
      if (alt == null) { wSkipped += 1; continue; }
      wPriced += 1; wActual += e.totalCost || 0; wAtDirector += alt;
    }
    tools.hermes = {
      attribution: 'per-session',
      delegationSessions: directorIds.size,
      director: finish(director),
      worker: finish(worker),
      workerModels: [...workerModels.entries()].map(([model, b]) => ({ model, ...finish(b) })).sort((a, b) => b.cost - a.cost),
      pairs: [...pairs.entries()].map(([pair, b]) => ({ pair, ...finish(b) })).sort((a, b) => b.cost - a.cost),
      // Hermes stores session totals, not per-turn usage, so the grunt-work
      // heuristic (a per-turn signal) doesn't apply — worker-vs-director only.
      advisor: {
        workerVsDirector: wPriced > 0
          ? { workersPriced: wPriced, workersSkipped: wSkipped, actualCost: round2(wActual), atDirectorCost: round2(wAtDirector), delta: round2(wAtDirector - wActual) }
          : null,
        directorGrunt: null,
      },
    };
  }

  // Tools without role markers: named honestly, never guessed.
  for (const tool of ['codex', 'grok']) {
    if (events.some((e) => e.tool === tool)) {
      tools[tool] = {
        attribution: 'none',
        note: `${tool} logs carry no subagent role markers (verified); cross-tool correlation is the planned view for it.`,
      };
    }
  }

  const totalDirector = round2((tools['claude-code'].director.cost || 0) + (tools.hermes.director.cost || 0));
  const totalWorker = round2((tools['claude-code'].worker.cost || 0) + (tools.hermes.worker.cost || 0));
  const denominator = totalDirector + totalWorker;
  return {
    generatedAt: new Date().toISOString(),
    tools,
    totals: {
      directorCost: totalDirector,
      workerCost: totalWorker,
      workerCostShare: denominator > 0 ? Math.round((totalWorker / denominator) * 100) : null,
    },
  };
}

// ─── Agent breakdown: worker cost grouped by subagent type + skills used ─────
// Complements buildDelegationReport (which splits director vs worker cost) by
// naming *which kind* of agent did the work. Joins worker turns to the Task
// call that spawned them (via the internal agent id from readClaudeAgentActivity)
// so cost is attributed per subagent_type (e.g. "Explore", "general-purpose").
// Skills come from Skill tool_use blocks. Worker turns with no roster entry
// (older inline sidechains) are counted as unattributed, never guessed.
export function buildAgentBreakdown(events, activities = []) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const roster = new Map();        // agentId -> { subagentType, description, model }
  const skillCounts = new Map();
  for (const a of activities) {
    for (const ag of a.agents || []) if (ag.agentId) roster.set(ag.agentId, ag);
    for (const s of a.skills || []) skillCounts.set(s.skill, (skillCounts.get(s.skill) || 0) + s.count);
  }

  const byType = new Map();
  let workerTurns = 0, attributedTurns = 0;
  for (const e of events) {
    if (e.role !== 'worker') continue;
    workerTurns += 1;
    const meta = e.agentId ? roster.get(e.agentId) : null;
    if (!meta) continue;
    attributedTurns += 1;
    const key = meta.subagentType || 'unknown';
    if (!byType.has(key)) {
      byType.set(key, { subagentType: key, turns: 0, cost: 0, agentIds: new Set(), descriptions: new Set(), models: new Set() });
    }
    const g = byType.get(key);
    g.turns += 1;
    g.cost += e.totalCost || 0;
    g.agentIds.add(e.agentId);
    if (meta.description) g.descriptions.add(meta.description);
    if (e.model) g.models.add(e.model);
  }

  const agents = [...byType.values()].map((g) => ({
    subagentType: g.subagentType,
    invocations: g.agentIds.size,
    turns: g.turns,
    cost: round2(g.cost),
    models: [...g.models],
    sampleDescriptions: [...g.descriptions].slice(0, 5),
  })).sort((a, b) => b.cost - a.cost);

  const skills = [...skillCounts.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count);

  return {
    agents,
    skills,
    coverage: { workerTurns, attributedTurns, unattributedTurns: workerTurns - attributedTurns },
    basis: 'Agent type + description come from Task tool calls in the main transcript, joined to worker token usage by an internal agent id that is never displayed. Older inline sidechains carry no type and count as unattributed.',
  };
}

// ─── Orchestration report (cross-tool "used together" windows) ──────────────
// Correlation-only: groups events by project (cwd), then merges each project's
// events into time windows where consecutive events (any tool) are within
// gapMinutes of each other, and keeps windows spanning ≥ 2 distinct tools.
// This is a heuristic — tools active in the same project close in time — never
// proof that one tool drove the other. Output language stays "overlapping
// usage" / "used together"; the fixed `basis` string carries the method.
// Events without a cwd cannot be attributed to a project and are reported in
// an honest `unattributed` bucket rather than guessed into a window.
// Events must already carry totalCost (the collector prices them).

export function buildOrchestrationReport(events, { gapMinutes = 10 } = {}) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const gapMs = gapMinutes * 60 * 1000;

  let overallCost = 0;
  for (const e of events || []) overallCost += e.totalCost || 0;

  // Split off events we can't attribute to a project.
  const attributed = [];
  const unattributed = { events: 0, cost: 0 };
  for (const e of events || []) {
    if (e.cwd) attributed.push(e);
    else { unattributed.events += 1; unattributed.cost += e.totalCost || 0; }
  }

  const byProject = new Map();
  for (const e of attributed) {
    if (!byProject.has(e.cwd)) byProject.set(e.cwd, []);
    byProject.get(e.cwd).push(e);
  }

  // Per-tool accumulator inside a window, tracking model cost for a top list.
  const toolBucket = () => ({ cost: 0, calls: 0, outputTokens: 0, models: new Map() });
  const addToBucket = (b, e) => {
    b.cost += e.totalCost || 0;
    b.calls += 1;
    b.outputTokens += e.outputTokens || 0;
    b.models.set(e.model, (b.models.get(e.model) || 0) + (e.totalCost || 0));
  };
  const finishTools = (toolMap) => {
    const out = {};
    for (const [tool, b] of toolMap) {
      out[tool] = {
        cost: round2(b.cost),
        calls: b.calls,
        outputTokens: b.outputTokens,
        models: [...b.models.entries()]
          .map(([model, cost]) => ({ model, cost: round2(cost) }))
          .sort((a, c) => c.cost - a.cost),
      };
    }
    return out;
  };

  const projects = [];
  let orchestratedCost = 0;
  let orchestratedWindowCount = 0;

  for (const [cwd, list] of byProject) {
    list.sort((a, b) => a.timestamp - b.timestamp);

    // Merge into runs where each consecutive gap is within the limit.
    const runs = [];
    let run = [];
    for (const e of list) {
      if (run.length && e.timestamp - run[run.length - 1].timestamp > gapMs) {
        runs.push(run);
        run = [];
      }
      run.push(e);
    }
    if (run.length) runs.push(run);

    const windows = [];
    for (const r of runs) {
      const toolMap = new Map();
      for (const e of r) {
        if (!toolMap.has(e.tool)) toolMap.set(e.tool, toolBucket());
        addToBucket(toolMap.get(e.tool), e);
      }
      if (toolMap.size < 2) continue; // single-tool activity is not orchestration

      const cost = r.reduce((s, e) => s + (e.totalCost || 0), 0);
      const start = r[0].timestamp;
      const end = r[r.length - 1].timestamp;
      windows.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        durationMinutes: Math.round((end - start) / 60000),
        cost: round2(cost),
        tools: finishTools(toolMap),
        toolCombination: [...toolMap.keys()].sort().join(' + '),
      });
    }

    if (!windows.length) continue;

    // Project aggregates over its orchestrated windows only.
    const perTool = new Map();
    const combos = new Map();
    let projectCost = 0;
    for (const w of windows) {
      projectCost += w.cost;
      combos.set(w.toolCombination, (combos.get(w.toolCombination) || 0) + 1);
      for (const [tool, t] of Object.entries(w.tools)) {
        perTool.set(tool, round2((perTool.get(tool) || 0) + t.cost));
      }
    }
    orchestratedCost += projectCost;
    orchestratedWindowCount += windows.length;

    projects.push({
      project: cwd,
      windows: windows.length,
      cost: round2(projectCost),
      perTool: [...perTool.entries()]
        .map(([tool, cost]) => ({ tool, cost }))
        .sort((a, b) => b.cost - a.cost),
      topCombination: [...combos.entries()].sort((a, b) => b[1] - a[1])[0][0],
      windowsDetail: windows,
    });
  }

  projects.sort((a, b) => b.cost - a.cost);

  return {
    generatedAt: new Date().toISOString(),
    basis: `heuristic correlation only: tools active in the same project within ${gapMinutes}-minute gaps are treated as overlapping usage, not proof one tool directed another`,
    gapMinutes,
    projects,
    unattributed: { events: unattributed.events, cost: round2(unattributed.cost) },
    totals: {
      orchestratedWindows: orchestratedWindowCount,
      orchestratedCost: round2(orchestratedCost),
      overallCost: round2(overallCost),
      orchestratedCostShare: overallCost > 0 ? Math.round((orchestratedCost / overallCost) * 100) : null,
    },
  };
}

// ─── Runaway-agent alarm (burn-rate spike vs your own baseline) ─────────────
// Flags when recent spend runs far above what's normal FOR YOU — the fear with
// background agents is a loop quietly eating the weekly cap. Two views:
//   hourly: last 60 min per tool vs the median active-hour spend for that tool
//   daily:  today (all tools) vs the median active day
// A spike needs both a high ratio AND an absolute floor, so tiny numbers never
// trip it. Baselines need enough history or the check stays silent (never
// guesses on sparse data). Events must already carry totalCost.

function median(sortedNums) {
  const n = sortedNums.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

export function buildBurnReport(events, opts = {}) {
  const now = opts.now || Date.now();
  const recentWindowMs = opts.recentWindowMs || 3600 * 1000;
  const factor = opts.factor || 3;
  const hourlyFloor = opts.hourlyFloor != null ? opts.hourlyFloor : 1;
  const dailyFloor = opts.dailyFloor != null ? opts.dailyFloor : 5;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const tools = {};
  const alerts = [];
  const toolNames = [...new Set(events.map((e) => e.tool || 'unknown'))];

  for (const tool of toolNames) {
    const te = events.filter((e) => (e.tool || 'unknown') === tool);
    const recent = te.filter((e) => e.timestamp >= now - recentWindowMs);
    const recentCost = round2(recent.reduce((s, e) => s + (e.totalCost || 0), 0));

    // Baseline: median spend across active clock-hours in history, excluding
    // the current burst so a runaway hour can't inflate its own baseline.
    const hourBuckets = new Map();
    for (const e of te) {
      if (e.timestamp >= now - recentWindowMs) continue;
      const key = Math.floor(e.timestamp / (3600 * 1000));
      hourBuckets.set(key, (hourBuckets.get(key) || 0) + (e.totalCost || 0));
    }
    const activeHours = [...hourBuckets.values()].filter((c) => c > 0).sort((a, b) => a - b);
    const baselineHourly = activeHours.length >= 5 ? median(activeHours) : null;
    const ratio = baselineHourly ? round2(recentCost / baselineHourly) : null;
    const spike = baselineHourly != null && recentCost >= hourlyFloor && ratio >= factor;

    tools[tool] = {
      recentCost,
      recentCalls: recent.length,
      baselineHourly: baselineHourly != null ? round2(baselineHourly) : null,
      ratio,
      spike,
      hasHistory: baselineHourly != null,
    };
    if (spike) {
      alerts.push({
        tool, kind: 'hourly', recentCost, ratio,
        baselineHourly: round2(baselineHourly),
        message: `${tool}: ~$${recentCost.toFixed(2)} in the last hour — ${ratio.toFixed(1)}× your typical active hour (~$${baselineHourly.toFixed(2)})`,
      });
    }
  }

  // Daily view across all tools.
  const dayBuckets = new Map();
  for (const e of events) {
    const d = new Date(e.timestamp); d.setHours(0, 0, 0, 0);
    dayBuckets.set(d.getTime(), (dayBuckets.get(d.getTime()) || 0) + (e.totalCost || 0));
  }
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayCost = round2(dayBuckets.get(todayStart.getTime()) || 0);
  const priorDays = [...dayBuckets.entries()]
    .filter(([k]) => k < todayStart.getTime()).map(([, c]) => c).filter((c) => c > 0).sort((a, b) => a - b);
  const baselineDaily = priorDays.length >= 3 ? median(priorDays) : null;
  const dailyRatio = baselineDaily ? round2(todayCost / baselineDaily) : null;
  const dailySpike = baselineDaily != null && todayCost >= dailyFloor && dailyRatio >= factor;
  const today = {
    cost: todayCost,
    baselineDaily: baselineDaily != null ? round2(baselineDaily) : null,
    ratio: dailyRatio,
    spike: dailySpike,
  };
  if (dailySpike) {
    alerts.push({
      tool: 'all', kind: 'daily', ratio: dailyRatio,
      message: `today: ~$${todayCost.toFixed(2)} — ${dailyRatio.toFixed(1)}× your typical day (~$${baselineDaily.toFixed(2)})`,
    });
  }

  return { generatedAt: new Date(now).toISOString(), factor, recentWindowMinutes: Math.round(recentWindowMs / 60000), tools, today, alerts };
}

// ─── Burn planner: forward-looking headroom against your own budgets ─────────
// The inverse of `limits`: given a budget YOU set (vendors don't publish real
// quotas) and your recent pace, how much room is left in this window and how
// long until you reach the budget. Everything is honest — the pace is stated
// with its basis, headroom needs a budget to exist (no invented ceiling), and
// ~$ stays an estimate. Pure: takes budgets as input, no config/env access.
//
// budgets shape: { claude: { fiveHour, weekly }, codex: {...}, global: { daily, weekly } }
// Any missing budget yields status 'no-budget' for that window (pace only).

const PLANNER_TOOL_MATCH = {
  claude: (e) => e.tool === 'claude-code',
  codex: (e) => e.tool === 'codex',
  grok: (e) => e.provider === 'xai',
};

export function buildBurnPlanner(events, {
  now = Date.now(),
  tools = ['claude', 'codex'],
  budgets = {},
  paceWindowMinutes = 60,
} = {}) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const paceMs = paceWindowMinutes * 60 * 1000;
  const evTokens = (e) => (e.inputTokens || 0) + (e.outputTokens || 0)
    + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0);

  // Sum cost + tokens over a set of events, and derive a per-hour pace from
  // only the most recent paceWindowMinutes so the ETA reflects current speed.
  const summarize = (scoped, sinceMs) => {
    const inWindow = scoped.filter((e) => e.timestamp >= sinceMs && e.timestamp <= now);
    let cost = 0, tokens = 0;
    for (const e of inWindow) { cost += e.totalCost || 0; tokens += evTokens(e); }
    return { cost, tokens, calls: inWindow.length };
  };

  // A budgeted window: current load, remaining room, and time-to-limit at pace.
  const windowPlan = (windowUsed, budget, pace, timeUnit) => {
    const used = round2(windowUsed.cost);
    const costPerToken = windowUsed.tokens > 0 ? windowUsed.cost / windowUsed.tokens : null;
    if (!budget || budget <= 0) {
      return { used, tokens: windowUsed.tokens, budget: null, status: 'no-budget' };
    }
    const remaining = Math.max(0, budget - windowUsed.cost);
    const percentUsed = Math.round((windowUsed.cost / budget) * 100);
    const tokensRemaining = costPerToken ? Math.round(remaining / costPerToken) : null;
    // ETA only when actively spending; idle → no false countdown.
    const perUnitCost = timeUnit === 'day' ? pace.perHourCost * 24 : pace.perHourCost;
    const timeToLimit = perUnitCost > 0 && remaining > 0 ? Math.round((remaining / perUnitCost) * 10) / 10 : null;
    return {
      used, tokens: windowUsed.tokens, budget: round2(budget),
      remaining: round2(remaining), tokensRemaining, percentUsed,
      timeToLimit, timeUnit,
      status: percentUsed >= 100 ? 'over' : percentUsed >= 80 ? 'approaching' : 'ok',
    };
  };

  const out = { generatedAt: new Date(now).toISOString(), paceWindowMinutes, tools: [] };

  for (const tool of tools) {
    const match = PLANNER_TOOL_MATCH[tool] || (() => false);
    const scoped = events.filter(match);
    const recent = summarize(scoped, now - paceMs);
    const pace = {
      perHourCost: round2(recent.cost / (paceWindowMinutes / 60)),
      perHourTokens: Math.round(recent.tokens / (paceWindowMinutes / 60)),
      basisMinutes: paceWindowMinutes,
    };
    const b = budgets[tool] || {};
    out.tools.push({
      tool,
      pace,
      fiveHour: windowPlan(summarize(scoped, now - 5 * 3600 * 1000), b.fiveHour, pace, 'hour'),
      weekly: windowPlan(summarize(scoped, now - 7 * 86400 * 1000), b.weekly, pace, 'day'),
    });
  }

  // Global (all tools) daily + weekly headroom — the budgets most people set.
  const g = budgets.global || {};
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const allRecent = summarize(events, now - paceMs);
  const allPace = {
    perHourCost: round2(allRecent.cost / (paceWindowMinutes / 60)),
    perHourTokens: Math.round(allRecent.tokens / (paceWindowMinutes / 60)),
    basisMinutes: paceWindowMinutes,
  };
  out.global = {
    pace: allPace,
    daily: windowPlan(summarize(events, todayStart.getTime()), g.daily, allPace, 'hour'),
    weekly: windowPlan(summarize(events, now - 7 * 86400 * 1000), g.weekly, allPace, 'day'),
  };

  return out;
}

// ─── Savings report (where the bill could shift cheaper) ────────────────────
// Frugon-style "where your bill leaks", but metadata-only and for coding
// agents + subscriptions. Identifies premium-model turns that LOOK routine
// (short prompt + short output + low context — the only signals we have; we
// never read prompt text) and prices the same tokens on the cheapest tier of
// the same provider. Non-routine premium turns are reported as correctly
// premium, so it never reads as "move everything". Zero token spend; silent
// on unpriced models. Because it can't judge true difficulty, the savings
// figure is an upper bound, stated as such.

const ROUTINE_THRESHOLDS = { maxInputTokens: 2000, maxOutputTokens: 400, maxCacheTokens: 20000 };

function cheaperTierFor(model, provider) {
  const m = String(model || '').toLowerCase();
  if (provider === 'anthropic' && /fable|opus|mythos/.test(m)) return 'claude-haiku-4-5';
  if (provider === 'openai' && /gpt-5\.\d/.test(m) && !m.includes('mini')) return 'gpt-5.4-mini';
  return null;
}

export function buildSavingsReport(events, { windowDays = 30 } = {}) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const priced = (model) => model && getPrice(model) != null && getPricingSource(model).confidence !== 'fallback';
  const isRoutine = (e) => (e.inputTokens || 0) < ROUTINE_THRESHOLDS.maxInputTokens
    && (e.outputTokens || 0) < ROUTINE_THRESHOLDS.maxOutputTokens
    && (e.cachedTokens || 0) + (e.cacheCreationTokens || 0) < ROUTINE_THRESHOLDS.maxCacheTokens;
  // Per-turn events only (Hermes session aggregates would distort the heuristic).
  const perTurn = events.filter((e) => e.source !== 'hermes-state-db');

  const byModel = new Map();
  let keptTurns = 0, keptCost = 0;

  for (const e of perTurn) {
    const cheaper = cheaperTierFor(e.model, e.provider);
    if (!cheaper || !priced(e.model) || !priced(cheaper)) continue;
    const key = e.model;
    if (!byModel.has(key)) {
      byModel.set(key, { provider: e.provider, model: e.model, cheaperModel: cheaper, totalTurns: 0, routineTurns: 0, routineCost: 0, atCheaperCost: 0 });
    }
    const g = byModel.get(key);
    g.totalTurns += 1;
    if (!isRoutine(e)) { keptTurns += 1; keptCost += e.totalCost || 0; continue; }
    const alt = priceCall(cheaper, e.inputTokens || 0, e.outputTokens || 0, e.cachedTokens || 0,
      e.cacheCreationTokens || 0, { cachedIncludedInInput: e.provider !== 'anthropic' }).totalCost;
    g.routineTurns += 1;
    g.routineCost += e.totalCost || 0;
    g.atCheaperCost += alt;
  }

  const models = [...byModel.values()]
    .map((g) => ({ ...g, routineCost: round2(g.routineCost), atCheaperCost: round2(g.atCheaperCost), savings: round2(g.routineCost - g.atCheaperCost) }))
    .filter((g) => g.routineTurns > 0 && g.savings > 0)
    .sort((a, b) => b.savings - a.savings);

  const savings = round2(models.reduce((s, g) => s + g.savings, 0));
  const routineCost = round2(models.reduce((s, g) => s + g.routineCost, 0));
  const atCheaperCost = round2(models.reduce((s, g) => s + g.atCheaperCost, 0));

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    models,
    totals: {
      routineCost,
      atCheaperCost,
      savings,
      monthlySavings: windowDays > 0 ? round2((savings / windowDays) * 30) : null,
    },
    keptPremium: { turns: keptTurns, cost: round2(keptCost) },
    thresholds: { ...ROUTINE_THRESHOLDS },
    basis: 'metadata heuristic: "routine" = short prompt + short output + low context. It cannot read actual prompt difficulty, so this is an upper bound on what could move cheaper.',
  };
}

// ─── Router-config export (4.4): savings → a policy your gateway can enforce ─
// Tokimeter observes; gateways (LiteLLM, OpenRouter, Foreman) route. This
// turns the savings report into a suggested routing policy: for each premium
// model with routine-looking turns, route requests under the routine
// thresholds to the cheaper same-provider tier. Thresholds come from the same
// heuristic that produced the savings figure, so policy and estimate always
// agree. Nothing is applied anywhere — this is an artifact the user feeds to
// their own gateway.

export function buildRoutingPolicy(savingsReport) {
  const t = savingsReport.thresholds || ROUTINE_THRESHOLDS;
  return {
    version: 1,
    generator: 'tokimeter savings --emit-policy',
    generatedAt: savingsReport.generatedAt,
    windowDays: savingsReport.windowDays,
    basis: savingsReport.basis,
    rules: (savingsReport.models || []).map((g) => ({
      match: {
        model: g.model,
        maxInputTokens: t.maxInputTokens,
        maxOutputTokens: t.maxOutputTokens,
        maxCachedContextTokens: t.maxCacheTokens,
      },
      route: g.cheaperModel,
      evidence: {
        routineTurns: g.routineTurns,
        totalTurns: g.totalTurns,
        estWindowSavings: g.savings,
      },
    })),
    estimatedWindowSavings: savingsReport.totals?.savings ?? 0,
    estimatedMonthlySavings: savingsReport.totals?.monthlySavings ?? null,
  };
}

export function formatRoutingPolicy(policy, format = 'json') {
  if (format === 'json') return JSON.stringify(policy, null, 2);

  const head = (c) => [
    `${c} Suggested routing policy — generated by Tokimeter from your last ${policy.windowDays} days of usage.`,
    `${c} Estimated savings if routine turns move cheaper: ~$${(policy.estimatedWindowSavings || 0).toFixed(2)} over the window (estimate, not a bill).`,
    `${c} "Routine" = short prompt + short output + low cached context; Tokimeter never reads prompt text, so review before enforcing.`,
  ];

  if (format === 'litellm') {
    const lines = [...head('#'), ''];
    lines.push('model_list:');
    for (const r of policy.rules) {
      const group = `${r.match.model}-routed`;
      lines.push(`  # ${r.evidence.routineTurns} of ${r.evidence.totalTurns} recent turns looked routine (~$${r.evidence.estWindowSavings.toFixed(2)} gap).`);
      lines.push(`  - model_name: ${group}`);
      lines.push(`    litellm_params:`);
      lines.push(`      model: ${r.route}`);
      lines.push(`  - model_name: ${group}-premium`);
      lines.push(`    litellm_params:`);
      lines.push(`      model: ${r.match.model}`);
      lines.push(`  # Send turns with input < ${r.match.maxInputTokens} tok and expected output < ${r.match.maxOutputTokens} tok to ${group};`);
      lines.push(`  # LiteLLM has no native token-threshold router, so enforce the split in your caller or pre-call hook.`);
    }
    if (!policy.rules.length) lines.push('  [] # no routine premium traffic found in the window — nothing to route cheaper');
    return lines.join('\n');
  }

  if (format === 'openrouter') {
    // OpenRouter request-level `models` preference lists: cheaper tier first
    // for routine calls; keep the premium model as the explicit fallback.
    return JSON.stringify({
      _comment: head('').map((s) => s.trim()).join(' '),
      routes: policy.rules.map((r) => ({
        when: r.match,
        request: { models: [r.route, r.match.model] },
        evidence: r.evidence,
      })),
    }, null, 2);
  }

  throw new Error(`unknown policy format: ${format} (expected json, litellm, or openrouter)`);
}

// ─── Session trace (4.5): explain one session's economics ────────────────────
// buildSessionTrace(events, query): query is a sessionId or unique prefix.
// Returns { trace } on a unique match, { matches } when ambiguous or empty
// query (recent-session listing), so the CLI can disambiguate. All numbers
// derive from the same per-event metadata the report uses — no new sources.

export function buildSessionTrace(events, query = '') {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const q = String(query || '').trim();

  const bySession = new Map();
  for (const e of events) {
    if (!e.sessionId) continue;
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }

  const summarize = (id, evs) => ({
    sessionId: id,
    tool: evs[0].tool,
    project: evs[0].cwd || null,
    turns: evs.length,
    cost: round2(evs.reduce((s, e) => s + (e.totalCost || 0), 0)),
    startedAt: new Date(Math.min(...evs.map((e) => e.timestamp))).toISOString(),
    endedAt: new Date(Math.max(...evs.map((e) => e.timestamp))).toISOString(),
  });

  const ids = [...bySession.keys()].filter((id) => !q || id.startsWith(q));
  if (ids.length !== 1) {
    const matches = ids
      .map((id) => summarize(id, bySession.get(id)))
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, 15);
    return { matches };
  }

  const evs = bySession.get(ids[0]).slice().sort((a, b) => a.timestamp - b.timestamp);
  const sum = (fn) => evs.reduce((s, e) => s + (fn(e) || 0), 0);
  const s = summarize(ids[0], evs);

  const byModel = new Map();
  for (const e of evs) {
    const key = `${e.model || 'unknown'}${e.effort ? ` ${e.effort}` : ''}`;
    const g = byModel.get(key) || { model: key, turns: 0, cost: 0 };
    g.turns += 1; g.cost += e.totalCost || 0;
    byModel.set(key, g);
  }

  const worker = evs.filter((e) => e.role === 'worker');
  const director = evs.filter((e) => e.role !== 'worker');
  const hasRoleMarkers = s.tool === 'claude-code' || s.tool === 'hermes';

  const cacheRead = sum((e) => e.cachedTokens);
  const cacheWrite = sum((e) => e.cacheCreationTokens);
  const input = sum((e) => e.inputTokens);
  const context = input + cacheRead + cacheWrite;

  return {
    trace: {
      ...s,
      durationMinutes: Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000),
      tokens: { input, output: sum((e) => e.outputTokens), cacheRead, cacheWrite },
      byModel: [...byModel.values()].map((g) => ({ ...g, cost: round2(g.cost) })).sort((a, b) => b.cost - a.cost),
      delegation: hasRoleMarkers
        ? { directorTurns: director.length, directorCost: round2(director.reduce((x, e) => x + (e.totalCost || 0), 0)),
            workerTurns: worker.length, workerCost: round2(worker.reduce((x, e) => x + (e.totalCost || 0), 0)) }
        : { basis: `${s.tool} logs carry no director/worker markers — delegation not attributable` },
      cache: {
        hitRate: context > 0 ? Math.round((cacheRead / context) * 100) : 0,
        readWriteRatio: cacheWrite > 0 ? Math.round((cacheRead / cacheWrite) * 10) / 10 : null,
      },
      topTurns: [...evs].sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, 3)
        .map((e) => ({ when: new Date(e.timestamp).toISOString(), model: e.model, cost: round2(e.totalCost || 0),
          contextTokens: (e.inputTokens || 0) + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0), outputTokens: e.outputTokens || 0 })),
    },
  };
}

// ─── Report export renderers (4.3): shareable Markdown / HTML ────────────────
// Pure functions over the report JSON that `tokimeter report --json` /
// `export` already produce. Same numbers, same wording rules (~$ = estimate,
// never a bill; factual, no advice); doubles as the freelancer chargeback
// deliverable via the per-project table.

const fmtMoney = (n) => `~$${(Number(n) || 0).toFixed(2)}`;
const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

export function renderReportMarkdown(report) {
  const t = report.totals || {};
  const roughMoney = (n) => Number(n) > 0 ? `${fmtMoney(n)} (excluded)` : '—';
  const rows = (list) => (list || []).map((r) => `| ${r.name} | ${fmtMoney(r.cost)} | ${roughMoney(r.roughEstimateCost)} | ${r.calls} |`).join('\n');
  const section = (title, list) => (list && list.length)
    ? `\n## ${title}\n\n| Name | Priced cost | Unknown-model rough | Calls |\n|---|---|---|---|\n${rows(list)}\n`
    : '';

  const lines = [];
  lines.push(`# Tokimeter report — last ${report.windowDays} days`);
  lines.push('');
  lines.push(`Generated ${report.generatedAt} · ${report.costBasis}.`);
  lines.push('');
  lines.push(`| | Priced cost | Unknown-model rough | Calls |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| Total (window) | ${fmtMoney(t.cost)} | ${roughMoney(t.roughEstimateCost)} | ${t.calls ?? ''} |`);
  if (report.today) lines.push(`| Today | ${fmtMoney(report.today.cost)} | ${roughMoney(report.today.roughEstimateCost)} | ${report.today.calls} |`);
  if (report.last7Days) lines.push(`| Last 7 days | ${fmtMoney(report.last7Days.cost)} | ${roughMoney(report.last7Days.roughEstimateCost)} | ${report.last7Days.calls} |`);
  lines.push('');
  lines.push(`Tokens: ${fmtTok(t.inputTokens)} in · ${fmtTok(t.outputTokens)} out · ${fmtTok(t.cachedTokens)} cache read · ${fmtTok(t.cacheCreationTokens)} cache write.`);
  if (report.cacheReadSavings > 0) lines.push(`Saved by prompt caching: ${fmtMoney(report.cacheReadSavings)}.`);

  lines.push(section('Pricing provenance', report.pricingSources));
  lines.push(section('By tool', report.byTool));
  lines.push(section('By provider', report.byProvider));
  lines.push(section('By access path', report.byAccessPath));
  lines.push(section('By model', report.byModel));
  lines.push(section('By project', report.byProject));

  if (report.byDay && report.byDay.length) {
    lines.push(`\n## By day\n\n| Date | Priced cost | Unknown-model rough | Calls |\n|---|---|---|---|`);
    for (const d of report.byDay) lines.push(`| ${d.date} | ${fmtMoney(d.cost)} | ${roughMoney(d.roughEstimateCost)} | ${d.calls} |`);
  }

  const s = report.savings;
  if (s && s.totals && s.totals.savings > 0) {
    lines.push(`\n## Savings opportunity (upper bound)\n`);
    lines.push(`Routine-looking premium turns cost ${fmtMoney(s.totals.routineCost)}; on the cheapest same-provider tier ${fmtMoney(s.totals.atCheaperCost)} — a ${fmtMoney(s.totals.savings)} gap over ${s.windowDays} days.`);
    lines.push(`_${s.basis}_`);
  }

  const ins = report.insights;
  if (ins) {
    lines.push(`\n## Insights\n`);
    if (ins.cacheHitRate != null) lines.push(`- Cache hit rate: ${ins.cacheHitRate}% of context tokens served from cache.`);
    for (const c of ins.coldCache || []) {
      lines.push(`- Cold cache — ${c.project}: ${fmtTok(c.cacheWriteTokens)} written vs ${fmtTok(c.cacheReadTokens)} read (${fmtMoney(c.cacheWriteCost)} in cache writes).`);
    }
    if (ins.largeContext && ins.largeContext.turns > 0) {
      lines.push(`- ${ins.largeContext.turns} turns exceeded ${fmtTok(ins.largeContext.threshold)} context tokens (${fmtMoney(ins.largeContext.cost)}).`);
    }
  }

  lines.push(`\n---\n_Priced values use provider/tool-reported costs or sourced API rates. Subscription values are API-equivalent, not a bill or invoice. Unknown-model rough estimates are excluded. No prompt or response content is read._`);
  // Empty strings come from skipped sections; collapse runs of blank lines
  // but keep the single blanks markdown tables and headings need.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export function renderReportHtml(report) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const t = report.totals || {};
  const roughMoney = (n) => Number(n) > 0 ? `${fmtMoney(n)} (excluded)` : '—';
  const table = (title, head, rows) => rows.length ? `
  <h2>${esc(title)}</h2>
  <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')}</tbody></table>` : '';
  const nameRows = (list) => (list || []).map((r) => [r.name, fmtMoney(r.cost), roughMoney(r.roughEstimateCost), r.calls]);

  const s = report.savings;
  const ins = report.insights || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tokimeter report — last ${esc(report.windowDays)} days</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:860px;margin:2rem auto;padding:0 1rem;color:#c8f5d0;background:#0b1410}
  h1,h2{color:#4ade80;font-weight:600} h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:2rem}
  table{border-collapse:collapse;width:100%;margin:.5rem 0} th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #1e3a2a;font-size:.9rem}
  th{color:#86efac} .muted{color:#6b8f77;font-size:.85rem} footer{margin-top:2.5rem;border-top:1px solid #1e3a2a;padding-top:1rem}
  @media print{body{background:#fff;color:#111} h1,h2,th{color:#166534} th,td{border-color:#ccc} .muted,footer{color:#555}}
</style></head><body>
  <h1>Tokimeter report — last ${esc(report.windowDays)} days</h1>
  <p class="muted">Generated ${esc(report.generatedAt)} · ${esc(report.costBasis)}.</p>
  ${table('Totals', ['', 'Priced cost', 'Unknown-model rough', 'Calls'], [
    ['Total (window)', fmtMoney(t.cost), roughMoney(t.roughEstimateCost), t.calls ?? ''],
    ...(report.today ? [['Today', fmtMoney(report.today.cost), roughMoney(report.today.roughEstimateCost), report.today.calls]] : []),
    ...(report.last7Days ? [['Last 7 days', fmtMoney(report.last7Days.cost), roughMoney(report.last7Days.roughEstimateCost), report.last7Days.calls]] : []),
  ])}
  <p class="muted">Tokens: ${fmtTok(t.inputTokens)} in · ${fmtTok(t.outputTokens)} out · ${fmtTok(t.cachedTokens)} cache read · ${fmtTok(t.cacheCreationTokens)} cache write${report.cacheReadSavings > 0 ? ` · saved by prompt caching ${fmtMoney(report.cacheReadSavings)}` : ''}.</p>
  ${table('Pricing provenance', ['Source', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.pricingSources))}
  ${table('By tool', ['Tool', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.byTool))}
  ${table('By provider', ['Provider', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.byProvider))}
  ${table('By access path', ['Access path', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.byAccessPath))}
  ${table('By model', ['Model', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.byModel))}
  ${table('By project', ['Project', 'Priced cost', 'Unknown-model rough', 'Calls'], nameRows(report.byProject))}
  ${table('By day', ['Date', 'Priced cost', 'Unknown-model rough', 'Calls'], (report.byDay || []).map((d) => [d.date, fmtMoney(d.cost), roughMoney(d.roughEstimateCost), d.calls]))}
  ${s && s.totals && s.totals.savings > 0 ? `
  <h2>Savings opportunity (upper bound)</h2>
  <p>Routine-looking premium turns cost ${fmtMoney(s.totals.routineCost)}; on the cheapest same-provider tier ${fmtMoney(s.totals.atCheaperCost)} — a ${fmtMoney(s.totals.savings)} gap over ${esc(s.windowDays)} days.</p>
  <p class="muted">${esc(s.basis)}</p>` : ''}
  ${ins.cacheHitRate != null ? `<h2>Insights</h2><p>Cache hit rate: ${esc(ins.cacheHitRate)}% of context tokens served from cache.</p>` : ''}
  <footer class="muted">Priced values use provider/tool-reported costs or sourced API rates. Subscription values are API-equivalent, not a bill or invoice. Unknown-model rough estimates are excluded. No prompt or response content is read.</footer>
</body></html>
`;
}

// ─── "My month in AI" share card (opt-in, metadata-only, no PII) ─────────────
// Aggregates one calendar month (UTC) of events into shareable stats: spend
// estimate, calls, tokens, active days, top tools/models, cache economics.
// Deliberately EXCLUDES projects, paths, and session ids — nothing on the
// card identifies what the user worked on. Sharing is a user action; nothing
// is uploaded anywhere.
export function buildMonthCard(events, { month, now = Date.now() } = {}) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const monthKey = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date(now).toISOString().slice(0, 7);
  const inMonth = events.filter((e) => new Date(e.timestamp).toISOString().slice(0, 7) === monthKey);

  const totals = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
  const byTool = new Map();
  const byModel = new Map();
  const byDay = new Map();
  let cacheReadSavings = 0;

  const bump = (map, key, cost) => {
    const cur = map.get(key) || { cost: 0, calls: 0 };
    cur.cost += cost; cur.calls += 1; map.set(key, cur);
  };

  for (const e of inMonth) {
    const cost = e.totalCost || 0;
    totals.cost += cost;
    totals.calls += 1;
    totals.inputTokens += e.inputTokens || 0;
    totals.outputTokens += e.outputTokens || 0;
    totals.cachedTokens += e.cachedTokens || 0;
    totals.cacheCreationTokens += e.cacheCreationTokens || 0;
    bump(byTool, e.tool || 'unknown', cost);
    bump(byModel, e.model || 'unknown', cost);
    bump(byDay, new Date(e.timestamp).toISOString().slice(0, 10), cost);
    const price = getPrice(e.model);
    if (price && (e.cachedTokens || 0) > 0) {
      const readRate = price.cached > 0 ? price.cached : price.input * 0.1;
      cacheReadSavings += ((e.cachedTokens || 0) / 1_000_000) * Math.max(0, price.input - readRate);
    }
  }

  const top = (map, n) => [...map.entries()]
    .map(([name, v]) => ({
      name,
      cost: round2(v.cost),
      calls: v.calls,
      share: totals.cost > 0 ? Math.round((v.cost / totals.cost) * 100) : 0,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, n);

  const days = [...byDay.entries()].map(([date, v]) => ({ date, cost: round2(v.cost) }));
  const busiest = days.slice().sort((a, b) => b.cost - a.cost)[0] || null;
  const contextTokens = totals.inputTokens + totals.cachedTokens + totals.cacheCreationTokens;

  const [y, m] = monthKey.split('-').map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return {
    generatedAt: new Date(now).toISOString(),
    month: monthKey,
    monthLabel,
    totals: { ...totals, cost: round2(totals.cost) },
    activeDays: days.length,
    busiestDay: busiest,
    topTools: top(byTool, 3),
    topModels: top(byModel, 3),
    cacheHitRate: contextTokens > 0 ? Math.round((totals.cachedTokens / contextTokens) * 100) : null,
    cacheReadSavings: round2(cacheReadSavings),
    basis: 'API-equivalent estimate from local token metadata only; not a bill. No prompt or response content is read.',
  };
}

// Renders a month card as a self-contained 1200×630 SVG (standard OG image
// size) in the Tokimeter green theme. Pure string builder — no I/O.
export function renderMonthCardSvg(card) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const money = (n) => `~$${(Number(n) || 0).toFixed(2)}`;
  const tok = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  };
  const t = card.totals;

  const barList = (items, x, y, title) => {
    const maxCost = Math.max(...items.map((i) => i.cost), 0.01);
    let out = `<text x="${x}" y="${y}" class="h2">${esc(title)}</text>`;
    items.forEach((item, i) => {
      const rowY = y + 34 + i * 52;
      const w = Math.max(6, Math.round((item.cost / maxCost) * 300));
      out += `
    <text x="${x}" y="${rowY}" class="label">${esc(item.name.length > 30 ? item.name.slice(0, 29) + '…' : item.name)}</text>
    <rect x="${x}" y="${rowY + 8}" width="${w}" height="10" rx="5" class="bar"/>
    <text x="${x + 320}" y="${rowY + 17}" class="val">${money(item.cost)} · ${item.share}%</text>`;
    });
    return out;
  };

  const statsRow = [
    [`${t.calls}`, 'API calls'],
    [`${tok(t.inputTokens + t.outputTokens)}`, 'tokens in+out'],
    [`${card.activeDays}`, 'active days'],
    ...(card.cacheHitRate != null ? [[`${card.cacheHitRate}%`, 'cache hit rate']] : []),
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="My month in AI — ${esc(card.monthLabel)}">
  <style>
    text{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
    .brand{fill:#4ade80;font-size:26px;font-weight:700}
    .title{fill:#86efac;font-size:30px}
    .big{fill:#4ade80;font-size:84px;font-weight:700}
    .bigsub{fill:#6b8f77;font-size:22px}
    .h2{fill:#86efac;font-size:22px;font-weight:600}
    .label{fill:#c8f5d0;font-size:19px}
    .val{fill:#6b8f77;font-size:18px}
    .stat{fill:#c8f5d0;font-size:34px;font-weight:700}
    .statlabel{fill:#6b8f77;font-size:17px}
    .foot{fill:#4a6b57;font-size:16px}
    .bar{fill:#4ade80;opacity:.85}
  </style>
  <rect width="1200" height="630" fill="#0b1410"/>
  <rect x="0" y="0" width="1200" height="6" fill="#4ade80"/>
  <text x="70" y="78" class="brand">Tokimeter</text>
  <text x="70" y="122" class="title">My month in AI · ${esc(card.monthLabel)}</text>
  <text x="70" y="248" class="big">${money(t.cost)}</text>
  <text x="70" y="286" class="bigsub">estimated API-equivalent spend</text>
  ${statsRow.map(([v, l], i) => `
  <text x="${70 + i * 200}" y="368" class="stat">${esc(v)}</text>
  <text x="${70 + i * 200}" y="394" class="statlabel">${esc(l)}</text>`).join('')}
  ${barList(card.topTools, 70, 440, 'Top tools')}
  ${barList(card.topModels, 640, 440, 'Top models')}
  ${card.cacheReadSavings > 0 ? `<text x="640" y="286" class="bigsub">saved ${money(card.cacheReadSavings)} via prompt caching</text>` : ''}
  <text x="70" y="614" class="foot">Local token metadata only · no prompt or response content · ~$ = estimate, not a bill · tokimeter.com</text>
</svg>
`;
}

// ─── opencode (~/.local/share/opencode) ──────────────────────────────────────
// opencode stores one JSON file per message (storage/message/{session}/msg_*.json)
// and, from 1.2+, the same message objects in the `data` column of the
// `message` table in opencode.db. Both carry the shape:
//   { id, sessionID, role, modelID, providerID, cost,
//     tokens: { input, output, reasoning?, cache: { read, write } },
//     time: { created (ms), completed? }, path?: { root } }
// Token buckets are disjoint (input excludes cache read/write). A positive
// `cost` is opencode's own request-time price and is kept as authoritative.
export function opencodeMessageToEvent(obj, { sinceMs = 0, fallbackId = '' } = {}) {
  if (!obj || typeof obj !== 'object' || obj.role !== 'assistant') return null;
  const tokens = obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : null;
  if (!tokens) return null;

  const timestamp = Number(obj.time && obj.time.created) || 0;
  if (!timestamp || (sinceMs && timestamp < sinceMs)) return null;

  const inputTokens = Math.max(0, Number(tokens.input) || 0);
  const outputTokens = Math.max(0, Number(tokens.output) || 0);
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const cachedTokens = Math.max(0, Number(cache.read) || 0);
  const cacheCreationTokens = Math.max(0, Number(cache.write) || 0);
  const reasoningTokens = Math.max(0, Number(tokens.reasoning) || 0);
  if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) return null;

  const cost = Number(obj.cost);
  const id = obj.id || fallbackId;
  return {
    timestamp,
    provider: obj.providerID || 'unknown',
    model: obj.modelID || 'unknown',
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    reasoningTokens,
    // opencode reports disjoint cache buckets regardless of provider.
    cachedDisjoint: true,
    totalCost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    pricingConfidence: Number.isFinite(cost) && cost > 0
      ? 'reported'
      : getPricingSource(obj.modelID || 'unknown').confidence,
    tool: 'opencode',
    source: 'opencode-message',
    confidence: 'exact',
    cwd: (obj.path && obj.path.root) || '',
    sessionId: obj.sessionID || '',
    externalId: id ? `opencode:${id}` : `opencode:${timestamp}:${inputTokens}:${outputTokens}`,
  };
}

// One msg_*.json file → zero or one event.
export function readOpencodeMessageFile(filePath, { sinceMs = 0 } = {}) {
  let obj = null;
  try {
    obj = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  return opencodeMessageToEvent(obj, { sinceMs, fallbackId: basename(filePath, '.json') });
}

// SQLite rows ({ data } JSON strings from the message table) → events.
export function opencodeRowsToEvents(rows, { sinceMs = 0 } = {}) {
  const events = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    let obj = null;
    try {
      obj = JSON.parse(row && row.data ? row.data : 'null');
    } catch {
      continue;
    }
    const event = opencodeMessageToEvent(obj, { sinceMs, fallbackId: row && row.id ? String(row.id) : '' });
    if (!event || seen.has(event.externalId)) continue;
    seen.add(event.externalId);
    events.push(event);
  }
  return events;
}

// ─── Cline (VS Code globalStorage / JetBrains / cline CLI) ───────────────────
// Cline writes one directory per task containing ui_messages.json (an array of
// UI events; `say: "api_req_started"` events carry a JSON `text` payload with
// tokensIn/tokensOut/cacheWrites/cacheReads/cost) and task_metadata.json
// (model_usage: [{ ts, model_id, model_provider_id, mode }]).
// PRIVACY: the api_req_started payload also embeds the request text — only the
// numeric usage fields and timestamps are read here; content is never kept.
// Cache buckets are disjoint from tokensIn (Anthropic-style accounting), and a
// positive `cost` is Cline's own request-time price, kept as authoritative.
export function clineTaskToEvents(uiMessages, { sinceMs = 0, taskId = '', modelUsage = [] } = {}) {
  const usage = (Array.isArray(modelUsage) ? modelUsage : [])
    .filter((m) => m && m.model_id)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const modelAt = (ts) => {
    let picked = usage[0] || null;
    for (const m of usage) {
      if ((m.ts || 0) <= ts) picked = m;
      else break;
    }
    return picked;
  };

  const events = [];
  const list = Array.isArray(uiMessages) ? uiMessages : [];
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (!msg || msg.type !== 'say' || !msg.text) continue;
    // deleted_api_reqs / subagent_usage are aggregates of the same counters —
    // included so truncated tasks still total correctly.
    if (msg.say !== 'api_req_started' && msg.say !== 'deleted_api_reqs' && msg.say !== 'subagent_usage') continue;
    let info = null;
    try {
      info = JSON.parse(msg.text);
    } catch {
      continue;
    }
    if (!info || typeof info !== 'object') continue;

    const timestamp = Number(msg.ts) || 0;
    if (!timestamp || (sinceMs && timestamp < sinceMs)) continue;

    const inputTokens = Math.max(0, Number(info.tokensIn) || 0);
    const outputTokens = Math.max(0, Number(info.tokensOut) || 0);
    const cachedTokens = Math.max(0, Number(info.cacheReads) || 0);
    const cacheCreationTokens = Math.max(0, Number(info.cacheWrites) || 0);
    if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) continue;

    const m = modelAt(timestamp);
    const cost = Number(info.cost);
    events.push({
      timestamp,
      provider: (m && m.model_provider_id) || 'unknown',
      model: (m && m.model_id) || 'unknown',
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      cachedDisjoint: true,
      totalCost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      pricingConfidence: Number.isFinite(cost) && cost > 0
        ? 'reported'
        : getPricingSource((m && m.model_id) || 'unknown').confidence,
      tool: 'cline',
      source: 'cline-ui-messages',
      confidence: 'exact',
      cwd: '',
      sessionId: taskId,
      externalId: `cline:${taskId}:${timestamp}:${i}`,
    });
  }
  return events;
}

// One task directory (ui_messages.json + optional task_metadata.json) → events.
export function readClineTaskEvents(taskDir, { sinceMs = 0 } = {}) {
  let uiMessages = null;
  try {
    uiMessages = JSON.parse(readFileSync(join(taskDir, 'ui_messages.json'), 'utf8'));
  } catch {
    return [];
  }
  let modelUsage = [];
  try {
    const meta = JSON.parse(readFileSync(join(taskDir, 'task_metadata.json'), 'utf8'));
    if (meta && Array.isArray(meta.model_usage)) modelUsage = meta.model_usage;
  } catch { /* metadata is optional — events fall back to model "unknown" */ }
  return clineTaskToEvents(uiMessages, { sinceMs, taskId: basename(taskDir), modelUsage });
}

// Cline CLI 3.x stores one metadata JSON plus one *.messages.json transcript
// per session under ~/.cline/data/sessions/<session-id>. Assistant messages
// expose numeric usage in `metrics` and model/provider in `modelInfo`. The same
// records also contain message content; only the fields below are retained.
export function clineSessionMessagesToEvents(payload, {
  sinceMs = 0,
  sessionId = '',
  provider = '',
  model = '',
  cwd = '',
} = {}) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const events = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== 'assistant' || !message.metrics || typeof message.metrics !== 'object') continue;
    const timestamp = Math.max(0, Number(message.ts) || 0);
    if (!timestamp || (sinceMs && timestamp < sinceMs)) continue;
    const metrics = message.metrics;
    const inputTokens = Math.max(0, Number(metrics.inputTokens) || 0);
    const outputTokens = Math.max(0, Number(metrics.outputTokens) || 0);
    const cachedTokens = Math.max(0, Number(metrics.cacheReadTokens) || 0);
    const cacheCreationTokens = Math.max(0, Number(metrics.cacheWriteTokens) || 0);
    if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) continue;

    const modelInfo = message.modelInfo && typeof message.modelInfo === 'object' ? message.modelInfo : {};
    const billingProvider = String(modelInfo.provider || provider || 'unknown').trim().toLowerCase();
    const normalizedProvider = billingProvider === 'openai-codex' ? 'openai' : billingProvider;
    const messageId = String(message.id || `${timestamp}:${i}`);
    const cost = Number(metrics.cost);
    events.push({
      timestamp,
      provider: normalizedProvider || 'unknown',
      model: String(modelInfo.id || model || 'unknown'),
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      cachedDisjoint: true,
      totalCost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      pricingConfidence: Number.isFinite(cost) && cost > 0
        ? 'reported'
        : getPricingSource(String(modelInfo.id || model || 'unknown')).confidence,
      tool: 'cline',
      source: 'cline-session-messages',
      confidence: 'exact',
      cwd: cwd || '',
      sessionId: sessionId || String(payload.sessionId || ''),
      externalId: `cline:${sessionId || payload.sessionId || 'session'}:${messageId}`,
      ...(billingProvider ? { billingProvider } : {}),
      ...(billingProvider === 'openai-codex' ? { accessPath: 'Codex OAuth (subscription)' } : {}),
    });
  }
  return events;
}

export function readClineSessionEvents(sessionDir, { sinceMs = 0 } = {}) {
  let files = [];
  try {
    files = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const messagesFile = files.find((name) => name.endsWith('.messages.json'));
  if (!messagesFile) return [];
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(join(sessionDir, messagesFile), 'utf8'));
  } catch {
    return [];
  }
  const metadataFile = files.find((name) => name.endsWith('.json') && !name.endsWith('.messages.json'));
  let metadata = {};
  if (metadataFile) {
    try { metadata = JSON.parse(readFileSync(join(sessionDir, metadataFile), 'utf8')) || {}; } catch {}
  }
  return clineSessionMessagesToEvents(payload, {
    sinceMs,
    sessionId: String(metadata.session_id || payload.sessionId || basename(sessionDir)),
    provider: String(metadata.provider || ''),
    model: String(metadata.model || ''),
    cwd: String(metadata.workspace_root || metadata.cwd || ''),
  });
}

// ─── GitHub Copilot CLI (~/.copilot/otel/*.jsonl) ────────────────────────────
// Copilot CLI exports OpenTelemetry spans/logs as JSONL. Usage appears on
// several record shapes; in priority order: chat spans, inference-detail logs,
// agent-turn logs, invoke_agent summary spans. Lower-priority records are
// suppressed when a higher-priority record from the same trace or response id
// already carries the usage (same scheme ccusage uses), so nothing double
// counts. Token attributes are the gen_ai.usage.* OTel conventions; input
// includes cache reads, so cache reads are subtracted to keep buckets disjoint.
const COPILOT_MODEL_ATTRS = ['gen_ai.response.model', 'gen_ai.request.model'];
const COPILOT_SESSION_ATTRS = [
  ['gen_ai.conversation.id', 3], ['copilot_chat.session_id', 3],
  ['copilot_chat.chat_session_id', 3], ['session.id', 3],
  ['github.copilot.interaction_id', 2], ['gen_ai.response.id', 1],
];

function copilotAttrNum(attrs, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const v = attrs[key];
    const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function copilotAttrStr(attrs, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// OTel exporters write timestamps as ISO strings, [seconds, nanos] pairs, or
// bare numbers in s/ms/µs/ns depending on the field — normalize to ms.
function copilotTimestampMs(record) {
  const candidates = [record.timestamp, record.time, record.observedTimestamp,
    record.timeUnixNano, record.endTime, record.startTime];
  for (const v of candidates) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 2) {
      const ms = Number(v[0]) * 1000 + Number(v[1]) / 1e6;
      if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
    }
    if (typeof v === 'string') {
      const parsed = Date.parse(v);
      if (parsed) return parsed;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n > 1e17) return Math.round(n / 1e6);   // nanoseconds
    if (n > 1e14) return Math.round(n / 1e3);   // microseconds
    if (n > 1e11) return Math.round(n);         // milliseconds
    return Math.round(n * 1000);                // seconds
  }
  return 0;
}

function copilotTraceId(record) {
  if (typeof record.traceId === 'string' && record.traceId) return record.traceId;
  const ctx = record.spanContext;
  if (ctx && typeof ctx === 'object' && typeof ctx.traceId === 'string') return ctx.traceId;
  return null;
}

function copilotIsSpan(record) {
  if (typeof record.type === 'string') return record.type === 'span';
  return typeof record.name === 'string'
    && (record.spanId != null || record.traceId != null || record.startTime != null
      || record.endTime != null || record.duration != null || record.kind != null);
}

// 0 = chat span … 3 = invoke_agent summary; -1 = not a usage record.
function copilotSourceRank(record, attrs) {
  const op = copilotAttrStr(attrs, 'gen_ai.operation.name');
  const name = typeof record.name === 'string' ? record.name : '';
  const body = typeof record.body === 'string' ? record.body
    : (typeof record._body === 'string' ? record._body : '');
  if (copilotIsSpan(record)) {
    if (op === 'chat' || name.startsWith('chat ')) return 0;
    if (op === 'invoke_agent' || name.startsWith('invoke_agent ')) return 3;
    return -1;
  }
  const eventName = copilotAttrStr(attrs, 'event.name');
  if (eventName === 'gen_ai.client.inference.operation.details' || body.startsWith('GenAI inference:')) return 1;
  if (eventName === 'copilot_chat.agent.turn' || body.startsWith('copilot_chat.agent.turn')) return 2;
  return -1;
}

export function copilotOtelTextToEvents(text, { sinceMs = 0, filePath = '', fallbackMs = 0 } = {}) {
  const candidates = [];
  const traceContexts = new Map(); // traceId → { model, sessionId, sessionPriority }

  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('"attributes"')) continue;
    const record = parseRecord(lines[i]);
    if (!record) continue;
    const attrs = record.attributes && typeof record.attributes === 'object' ? record.attributes : null;
    if (!attrs) continue;

    const traceId = copilotTraceId(record);
    if (traceId) {
      const ctx = traceContexts.get(traceId) || { model: null, sessionId: null, sessionPriority: 0 };
      if (!ctx.model) ctx.model = copilotAttrStr(attrs, COPILOT_MODEL_ATTRS);
      for (const [key, priority] of COPILOT_SESSION_ATTRS) {
        const v = copilotAttrStr(attrs, key);
        if (v && priority > ctx.sessionPriority) { ctx.sessionId = v; ctx.sessionPriority = priority; }
      }
      traceContexts.set(traceId, ctx);
    }

    const rank = copilotSourceRank(record, attrs);
    if (rank < 0) continue;

    const rawInput = copilotAttrNum(attrs, 'gen_ai.usage.input_tokens');
    const outputTokens = copilotAttrNum(attrs, 'gen_ai.usage.output_tokens');
    const cachedTokens = copilotAttrNum(attrs, 'gen_ai.usage.cache_read.input_tokens');
    const cacheCreationTokens = copilotAttrNum(attrs, ['gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens']);
    const reasoningTokens = copilotAttrNum(attrs, ['gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.reasoning_tokens']);
    const inputTokens = Math.max(0, rawInput - Math.min(rawInput, cachedTokens));
    if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens + reasoningTokens === 0) continue;

    const timestamp = copilotTimestampMs(record);
    candidates.push({
      rank, traceId, index: i,
      responseId: copilotAttrStr(attrs, 'gen_ai.response.id'),
      model: copilotAttrStr(attrs, COPILOT_MODEL_ATTRS),
      sessionId: (COPILOT_SESSION_ATTRS.map(([k]) => copilotAttrStr(attrs, k)).find(Boolean)) || null,
      timestamp, inputTokens, outputTokens, cachedTokens, cacheCreationTokens, reasoningTokens,
    });
  }

  // Suppress records whose trace/response already produced a higher-priority
  // usage record.
  const tracesByRank = [0, 1, 2].map((r) => new Set(candidates.filter((c) => c.rank === r && c.traceId).map((c) => c.traceId)));
  const responsesByRank = [0, 1, 2].map((r) => new Set(candidates.filter((c) => c.rank === r && c.responseId).map((c) => c.responseId)));
  const shadowed = (c) => {
    for (let r = 0; r < c.rank; r++) {
      if (c.traceId && tracesByRank[r] && tracesByRank[r].has(c.traceId)) return true;
      if (c.responseId && responsesByRank[r] && responsesByRank[r].has(c.responseId)) return true;
    }
    return false;
  };

  const events = [];
  for (const c of candidates) {
    if (shadowed(c)) continue;
    const timestamp = c.timestamp || fallbackMs;
    if (!timestamp || (sinceMs && timestamp < sinceMs)) continue;
    const ctx = c.traceId ? traceContexts.get(c.traceId) : null;
    const model = c.model || (ctx && ctx.model) || 'unknown';
    const sessionId = c.sessionId || (ctx && ctx.sessionId) || c.traceId || '';
    events.push({
      timestamp,
      provider: 'github',
      model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cachedTokens: c.cachedTokens,
      cacheCreationTokens: c.cacheCreationTokens,
      reasoningTokens: c.reasoningTokens,
      cachedDisjoint: true,
      totalCost: 0,
      tool: 'copilot',
      source: 'copilot-otel',
      confidence: 'exact',
      cwd: '',
      sessionId,
      externalId: `copilot:${c.traceId || sessionId || filePath}:${timestamp}:${c.index}`,
    });
  }
  return events;
}

export function readCopilotOtelEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  let fallbackMs = 0;
  try {
    text = readFileSync(filePath, 'utf8');
    fallbackMs = statSync(filePath).mtimeMs;
  } catch {
    return [];
  }
  return copilotOtelTextToEvents(text, { sinceMs, filePath, fallbackMs });
}

// ─── Cursor CLI (stop-hook capture → ~/.tokimeter/cursor-usage.jsonl) ────────
// Cursor's local transcripts carry no token usage (verified), but its stop /
// subagentStop hooks receive exact per-turn usage: { conversation_id,
// generation_id, model, status, input_tokens, output_tokens,
// cache_read_tokens, cache_write_tokens } where input_tokens already has the
// cache buckets subtracted (disjoint, Anthropic-style). `tokimeter setup
// cursor` registers a hook that prices each payload and appends one metadata-
// only JSONL record; these functions turn payloads/records into events.
export function cursorStopPayloadToRecord(payload, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const inputTokens = Math.max(0, Number(payload.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(payload.output_tokens) || 0);
  const cachedTokens = Math.max(0, Number(payload.cache_read_tokens) || 0);
  const cacheCreationTokens = Math.max(0, Number(payload.cache_write_tokens) || 0);
  // Grok Build also reads ~/.cursor/hooks.json. Current Grok versions can
  // forward token-bearing Stop payloads, but they do not carry Cursor's own
  // hook provenance. Drop those or they are mislabeled and double counted.
  const hookEvent = String(payload.hook_event_name || '');
  const cursorVersion = String(payload.cursor_version || '');
  const looksLikeForwardedGrok = /^grok-/i.test(String(payload.model || ''))
    && (!cursorVersion || !['stop', 'subagentStop'].includes(hookEvent));
  if (looksLikeForwardedGrok) return null;

  if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) return null;

  const rawModel = String(payload.model || 'unknown');
  const model = rawModel === 'default' ? 'cursor-auto' : rawModel;
  const workspaceRoots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];

  return {
    ts: now,
    conversationId: String(payload.conversation_id || ''),
    generationId: String(payload.generation_id || ''),
    model,
    status: String(payload.status || ''),
    cwd: String(payload.workspace_root || payload.cwd || workspaceRoots[0] || ''),
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    cursorVersion,
    hookEvent,
  };
}

export function cursorRecordToEvent(record) {
  if (!record || typeof record !== 'object' || !Number(record.ts)) return null;
  // Records captured before Cursor provenance was persisted can include Grok
  // Build's compatibility-hook forwards. They are already counted by Grok's
  // own log reader, so exclude them from the Cursor view.
  if (/^grok-/i.test(String(record.model || '')) && !record.cursorVersion) return null;
  const inputTokens = Math.max(0, Number(record.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(record.outputTokens) || 0);
  const cachedTokens = Math.max(0, Number(record.cachedTokens) || 0);
  const cacheCreationTokens = Math.max(0, Number(record.cacheCreationTokens) || 0);
  if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) return null;
  const cost = Number(record.totalCost);
  const model = record.model === 'default' ? 'cursor-auto' : (record.model || 'unknown');
  return {
    timestamp: Number(record.ts),
    provider: 'cursor',
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    cachedDisjoint: true,
    totalCost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    roughEstimateCost: Math.max(0, Number(record.roughEstimateCost) || 0),
    pricingConfidence: record.pricingConfidence || getPricingSource(model).confidence,
    tool: 'cursor',
    source: record.source || 'cursor-stop-hook',
    confidence: 'exact',
    cwd: record.cwd || '',
    sessionId: record.conversationId || '',
    externalId: record.generationId
      ? `cursor:${record.generationId}`
      : `cursor:${record.conversationId}:${record.ts}`,
  };
}

export function readCursorUsageEvents(filePath, { sinceMs = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line);
    const event = cursorRecordToEvent(record);
    if (!event) continue;
    if (sinceMs && event.timestamp < sinceMs) continue;
    if (seen.has(event.externalId)) continue; // a re-fired hook may append twice
    seen.add(event.externalId);
    events.push(event);
  }
  return events;
}

// ─── Cursor dashboard CSV import (desktop chat coverage) ─────────────────────
// Cursor's classic in-editor chat fires no hooks and writes no local usage;
// the only record is the usage CSV exportable from cursor.com's dashboard.
// Three header layouts exist:
//   v1: Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,
//       Output Tokens,Total Tokens,Cost,Cost to you
//   v2: Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),
//       Cache Read,Output Tokens,Total Tokens,Cost
//   v3: Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,… (as v2, shifted)
// Input (w/ Cache Write) includes cache-write tokens; the disjoint buckets are
// input = "w/o", cacheWrite = "w/" − "w/o", cacheRead = its own column.
// Cost is Cursor's own billed figure — kept as authoritative when > 0
// ("Included"/"-" plan usage parses to 0 and is estimated like everything else).
export function parseCursorUsageCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  if (!header.some((h) => h.trim() === 'Date') || !header.some((h) => h.trim() === 'Model')) return [];

  const hasKind = header.some((h) => h.trim() === 'Kind');
  const v3 = hasKind && header.length >= 11;
  const idx = v3
    ? { model: 4, withCw: 6, withoutCw: 7, cacheRead: 8, output: 9, cost: 11 }
    : hasKind
      ? { model: 2, withCw: 4, withoutCw: 5, cacheRead: 6, output: 7, cost: 9 }
      : { model: 1, withCw: 2, withoutCw: 3, cacheRead: 4, output: 5, cost: 7 };
  // v1 has a separate "Cost to you" column with the post-plan price — prefer it.
  const costToYou = header.findIndex((h) => h.trim() === 'Cost to you');

  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[$,]/g, '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 6) continue;
    const ts = Date.parse(cells[0]);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const model = String(cells[idx.model] || '').trim();
    if (!model) continue;
    const withCw = num(cells[idx.withCw]);
    const withoutCw = num(cells[idx.withoutCw]);
    const cachedTokens = num(cells[idx.cacheRead]);
    const outputTokens = num(cells[idx.output]);
    const inputTokens = withoutCw;
    const cacheCreationTokens = Math.max(0, withCw - withoutCw);
    if (inputTokens + outputTokens + cachedTokens + cacheCreationTokens === 0) continue;
    const cost = costToYou >= 0 ? num(cells[costToYou]) : num(cells[idx.cost]);

    records.push({
      ts,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens,
      ...(cost > 0 ? { totalCost: cost } : {}),
      source: 'cursor-csv-import',
      // Content-derived id: re-importing the same CSV (or an overlapping later
      // export) dedupes naturally in the reader.
      generationId: `csv-${ts}-${model}-${inputTokens}-${outputTokens}-${cachedTokens}-${cacheCreationTokens}`,
    });
  }
  return records;
}

// Minimal CSV field splitter (handles quoted cells with commas).
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
