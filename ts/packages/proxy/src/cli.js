#!/usr/bin/env node

/**
 * Tokimeter CLI Wrapper
 *
 * Wraps any CLI tool with cost tracking. Instead of running:
 *   claude "refactor this"
 *   codex "fix this bug"
 *   aider --message "add tests"
 *
 * You run:
 *   tm claude "refactor this"
 *   tm codex "fix this bug"
 *   tm aider --message "add tests"
 *
 * The wrapper:
 *   1. Ensures the proxy is running (starts it if not)
 *   2. Sets the right environment variables
 *   3. Runs the real CLI tool
 *   4. Shows cost summary when done
 *
 * Uses Node.js built-ins, with optional node-pty for interactive terminal overlays.
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import http from 'node:http';
import { readClaudeUsageEvents, readClaudeAgentActivity, readCodexTokenEvents, readAiderHistoryEvents, readGrokUsageEvents, readGrokSessionMeta, analyzeLogFileFormat, readCodexRateLimitSnapshots, buildHermesSessionQuery, hermesRowsToEvents, buildDelegationReport, buildAgentBreakdown, buildOrchestrationReport, buildBurnReport, buildBurnPlanner, buildSavingsReport, buildRoutingPolicy, formatRoutingPolicy, renderReportMarkdown, renderReportHtml, buildSessionTrace, buildMonthCard, renderMonthCardSvg, readOpencodeMessageFile, opencodeRowsToEvents, readClineTaskEvents, readClineSessionEvents, readCopilotOtelEvents, cursorStopPayloadToRecord, readCursorUsageEvents, parseCursorUsageCsv, recentCodexRolloutFiles as recentCodexRolloutFilesShared } from './parsers.js';
import {
  chunkCloudEvents,
  clearCloudPause,
  cloudPauseActive,
  cloudPauseState,
  cloudResponseResult,
  eventToCloudPayload,
  newestFirstCloudEvents,
  sendCloudBatchWithRetry,
} from './cloud-sync.js';

const {
  addCustomPrice,
  getPrice,
  getPricingSource,
  listModels,
  priceCall,
  pricingFeedStatus,
  refreshPricingFeed,
} = await importCorePricing();

const require = createRequire(import.meta.url);
const PROXY_PORT = parseInt(process.env.TOKIMETER_PORT || '8788', 10);
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
// Same override the proxy server honors — keeps CLI and server pointed at
// one data dir when isolated (tests, demos).
const DATA_DIR = process.env.TOKIMETER_DATA_DIR || join(homedir(), '.tokimeter');
const PID_FILE = join(DATA_DIR, 'proxy.pid');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const CLOUD_SYNC_STATE_FILE = join(DATA_DIR, 'cloud-sync-state.json');
const CALLS_FILE = join(DATA_DIR, 'calls.jsonl');
const SHIM_BIN_DIR = join(DATA_DIR, 'bin');
const CLI_PATH = new URL(import.meta.url).pathname;
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const CODEX_API_PROFILE = join(CODEX_HOME, 'tokimeter.config.toml');
const CODEX_CHATGPT_PROFILE = join(CODEX_HOME, 'tokimeter-chatgpt.config.toml');
const CODEX_PROFILES_PREV = join(DATA_DIR, 'codex-profiles-prev.json');
const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok');
const GROK_UNIFIED_LOG = join(GROK_HOME, 'logs', 'unified.jsonl');
const GROK_SESSIONS_DIR = join(GROK_HOME, 'sessions');
const GROK_HOOK_FILE = join(GROK_HOME, 'hooks', 'tokimeter.json');
const GROK_PULSE_STATE = join(DATA_DIR, 'grok-pulse-state.json');
const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes');
const HERMES_STATE_DB = join(HERMES_HOME, 'state.db');
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_HOME, 'settings.json');
const CLAUDE_PROJECTS_DIR = join(CLAUDE_HOME, 'projects');
const CLAUDE_STATUSLINE_SCRIPT = join(DATA_DIR, 'claude-statusline.mjs');
const CLAUDE_STATUSLINE_PREV = join(DATA_DIR, 'claude-statusline-prev.json');
const CURSOR_HOME = process.env.CURSOR_HOME || join(homedir(), '.cursor');
const CURSOR_CLI_CONFIG = join(CURSOR_HOME, 'cli-config.json');
const CURSOR_HOOKS_FILE = join(CURSOR_HOME, 'hooks.json');
const CURSOR_USAGE_LOG = join(DATA_DIR, 'cursor-usage.jsonl');
const CURSOR_STATUSLINE_SCRIPT = join(DATA_DIR, 'cursor-statusline.mjs');
const CURSOR_STATUSLINE_PREV = join(DATA_DIR, 'cursor-statusline-prev.json');
const PROXY_PACKAGE_JSON = join(dirname(CLI_PATH), '..', 'package.json');
const AUTO_PATH_START = '# >>> Tokimeter PATH >>>';
const AUTO_PATH_END = '# <<< Tokimeter PATH <<<';
const DEFAULT_CONNECT_URL = process.env.TOKIMETER_CONNECT_URL
  || 'https://tokimeter.com/api/device-connect';

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

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  printHelp();
  process.exit(0);
}

// Handle special commands
if (args[0] === 'start') {
  await startProxy(true);
  process.exit(0);
}
if (args[0] === 'stop') {
  await stopProxy();
  process.exit(0);
}
if (args[0] === 'status') {
  await showStatus();
  process.exit(0);
}
if (args[0] === 'watch') {
  await runWatch(args.slice(1));
  process.exit(0);
}
if (args[0] === 'latest') {
  await runLatest(args.slice(1));
  process.exit(0);
}
if (args[0] === 'report') {
  await runReport(args.slice(1));
  process.exit(0);
}
if (args[0] === 'agents') {
  await runAgents(args.slice(1));
  process.exit(0);
}
if (args[0] === 'burn') {
  await runBurn(args.slice(1));
  process.exit(0);
}
if (args[0] === 'savings') {
  await runSavings(args.slice(1));
  process.exit(0);
}
if (args[0] === 'trace') {
  await runTrace(args.slice(1));
  process.exit(0);
}
if (args[0] === 'plan') {
  await runPlan(args.slice(1));
  process.exit(0);
}
if (args[0] === 'card') {
  await runCard(args.slice(1));
  process.exit(0);
}
if (args[0] === 'cursor-capture') {
  await runCursorCapture();
  process.exit(0);
}
if (args[0] === 'grok-pulse') {
  await runGrokPulse();
  process.exit(0);
}
if (args[0] === 'cursor-import') {
  await runCursorImport(args.slice(1));
  process.exit(process.exitCode || 0);
}
if (args[0] === 'export') {
  // Alias for `report --json`: the file the Pro dashboard's local mode loads.
  await runReport([...args.slice(1).filter(a => a !== '--json'), '--json']);
  process.exit(0);
}
if (args[0] === 'limits') {
  await runLimits(args.slice(1));
  process.exit(0);
}
if (args[0] === 'compare') {
  await runCompare(args.slice(1));
  process.exit(0);
}
if (args[0] === 'codex-import') {
  await importCodexRolloutTokenCounts({ verbose: true, ...parseCodexImportArgs(args.slice(1)) });
  process.exit(0);
}
if (args[0] === 'aider-import') {
  await importAiderHistory(args.slice(1));
  process.exit(process.exitCode || 0);
}
if (args[0] === 'grok-import') {
  await importGrokUsage(args.slice(1));
  process.exit(0);
}
if (args[0] === 'hermes-import') {
  await importHermesUsage(args.slice(1));
  process.exit(0);
}
if (args[0] === 'claude-import') {
  const importOptions = parseClaudeImportArgs(args.slice(1));
  await importClaudeTranscriptUsage({ verbose: !importOptions.quiet, ...importOptions });
  process.exit(0);
}
if (args[0] === 'setup') {
  await setupTool(args.slice(1));
  process.exit(0);
}
if (args[0] === 'uninstall' || args[0] === 'restore') {
  uninstallAutoSetup();
  process.exit(0);
}
if (args[0] === 'doctor') {
  await runDoctor();
  process.exit(0);
}
if (args[0] === 'ready') {
  await runReady();
  process.exit(0);
}
if (args[0] === 'repair') {
  await runRepair();
  process.exit(0);
}
if (args[0] === 'advisor-test') {
  runAdvisorTest(args.slice(1));
  process.exit(0);
}
if (args[0] === 'pricing') {
  await runPricingCommand(args.slice(1));
  process.exit(0);
}
if (args[0] === 'config') {
  runConfigCommand(args.slice(1));
  process.exit(0);
}
if (args[0] === 'login') {
  await runLogin(args.slice(1));
  process.exit(process.exitCode || 0);
}
if (args[0] === 'connect') {
  await runConnect(args.slice(1));
  process.exit(process.exitCode || 0);
}
if (args[0] === 'sync') {
  await runCloudSync(args.slice(1));
  process.exit(process.exitCode || 0);
}
if (args[0] === 'logout') {
  runLogout();
  process.exit(0);
}
if (args[0] === 'postinstall') {
  runPostinstall();
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
  console.log(readProxyPackageVersion());
  process.exit(0);
}
if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
  printHelp();
  process.exit(0);
}

// Otherwise: wrap a CLI tool
const tool = args[0];
const toolArgs = args.slice(1);

// ─── Tool-specific configuration ────────────────────────────────────────────

const TOOL_CONFIG = {
  claude: {
    name: 'Claude Code',
    envVar: 'ANTHROPIC_BASE_URL',
    detect: 'claude',
  },
  codex: {
    name: 'Codex CLI',
    envVar: () => process.env.OPENAI_API_KEY ? 'OPENAI_BASE_URL' : null,
    detect: 'codex',
    setup: ensureCodexProfiles,
    args: (toolArgs) => process.env.OPENAI_API_KEY ? ['--profile', 'tokimeter', ...toolArgs] : toolArgs,
    capture: (toolArgs) => process.env.OPENAI_API_KEY || !isCodexExec(toolArgs) ? null : 'codex-summary',
  },
  'codex-api': {
    name: 'Codex CLI (API key)',
    envVar: 'OPENAI_BASE_URL',
    detect: 'codex',
    setup: ensureCodexProfiles,
    args: (toolArgs) => ['--profile', 'tokimeter', ...toolArgs],
  },
  'codex-chatgpt': {
    name: 'Codex CLI (ChatGPT subscription)',
    detect: 'codex',
    setup: ensureCodexProfiles,
    args: (toolArgs) => toolArgs,
    capture: (toolArgs) => isCodexExec(toolArgs) ? 'codex-summary' : null,
    cleanEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  },
  openai: {
    name: 'OpenAI CLI',
    // The openai SDK's OPENAI_BASE_URL replaces the whole default base
    // (https://api.openai.com/v1), so ours must include /v1 too.
    envVar: 'OPENAI_BASE_URL',
    envValue: () => `${PROXY_URL}/v1`,
    detect: 'openai',
  },
  aider: {
    name: 'Aider',
    // Aider's OPENAI_API_BASE expects a full OpenAI-compatible endpoint
    // incl. /v1 (see aider.chat/docs/llms/openai-compat.html). Applies to
    // OpenAI-provider models; aider routes other providers separately.
    envVar: 'OPENAI_API_BASE',
    envValue: () => `${PROXY_URL}/v1`,
    detect: 'aider',
  },
  // Note: Cursor's cursor-agent CLI has no custom-endpoint support (no
  // OPENAI_BASE_URL equivalent as of 2026-07; only CURSOR_API_KEY /
  // CURSOR_CONFIG_DIRS exist), so Tokimeter cannot honestly claim to track
  // it. The wrapper entry was removed rather than silently doing nothing.
};

const config = TOOL_CONFIG[tool];

if (!config) {
  console.error(`\n  ❌ Unknown tool: "${tool}"`);
  console.error(`  Supported tools: ${Object.keys(TOOL_CONFIG).join(', ')}\n`);
  process.exit(1);
}

const captureMode = typeof config.capture === 'function' ? config.capture(toolArgs) : config.capture;

// ─── Run ────────────────────────────────────────────────────────────────────

// 1. Ensure proxy is running
if (!(await ensureProxyRunning(captureMode === 'codex-summary', true))) {
  process.exit(1);
}

// 1b. Tool-specific local setup
if (config.setup) {
  await config.setup();
}

// 2. Set environment variable
const envVar = typeof config.envVar === 'function' ? config.envVar() : config.envVar;
const env = {
  ...process.env,
};
if (envVar) {
  env[envVar] = typeof config.envValue === 'function' ? config.envValue() : PROXY_URL;
}
env.PATH = stripShimDirFromPath(env.PATH || '');
for (const key of config.cleanEnv || []) {
  delete env[key];
}

// 3. Get cost before
const costBefore = await fetchSummary();

// 4. Run the tool
const resolvedToolArgs = config.args ? config.args(toolArgs) : toolArgs;
const willRunCodexPty = shouldRunCodexPty(tool, envVar, captureMode, toolArgs);
const willRunClaudePty = shouldRunClaudePty(tool, toolArgs);
const willRunPty = willRunCodexPty || willRunClaudePty;
console.error(`\n  💰 Tokimeter tracking enabled for ${config.name}\n`);
if (isCodexChatGptMode(tool, envVar, captureMode) && isLikelyCodexInteractiveArgs(toolArgs)) {
  if (willRunCodexPty) {
    console.error(`  Overlay active. The durable Tokimeter status lives in the bottom bar.`);
    console.error(`     Set TOKIMETER_PTY=0 to disable the PTY overlay.\n`);
  } else {
    console.error(`  Note: Interactive Codex ChatGPT mode runs in the real Codex terminal UI.`);
    console.error(`     Tokimeter uses terminal-title/log updates because the PTY overlay is unavailable or disabled.`);
    console.error(`     Set TOKIMETER_INLINE=0 to mute inline notes.`);
    console.error(`     Use "codex exec ..." for final-summary estimates, or API-key mode for exact proxied usage.\n`);
  }
}
if (tool === 'claude' && toolArgs.length === 0) {
  if (willRunClaudePty) {
    console.error(`  Claude advisor active. Tokimeter uses local prompt rules only; no extra tokens.`);
    console.error(`     Ctrl+T accepts a cheaper-model suggestion, Enter sends anyway, Esc dismisses.`);
    console.error(`     Set TOKIMETER_CLAUDE_ADVISOR=0 to disable Claude advisor prompts.\n`);
  } else {
    console.error(`  Claude native status line is active when configured.`);
    console.error(`     PTY advisor unavailable or disabled; set TOKIMETER_PTY=0 to keep this mode.\n`);
  }
}
const preflightHint = getPreflightHint(tool, toolArgs);
const overlayStartupHint = preflightHint || getInteractiveStartupHint(tool, toolArgs);
if (preflightHint && !willRunPty) {
  console.error(`  Savings hint: ${preflightHint}`);
  console.error(`     Tokimeter used local rules only; no extra tokens were spent on this recommendation.\n`);
}

const startedAt = Date.now();
const captured = { stdout: '', stderr: '' };
let inlineMonitor = null;

async function finishRun(code) {
  if (inlineMonitor) {
    await inlineMonitor.stop();
    inlineMonitor = null;
  }

  if (tool === 'claude') {
    await importClaudeTranscriptUsage({
      verbose: false,
      limit: 12,
      sinceMs: startedAt - 5000,
    });
  }

  // 5. Get cost after
  await sleep(500); // give proxy a moment to process the last call
  let costAfter = await fetchSummary();

  let globalDeltaCost = (costAfter?.totalCost || 0) - (costBefore?.totalCost || 0);
  let globalDeltaCalls = (costAfter?.totalCalls || 0) - (costBefore?.totalCalls || 0);
  let sessionUsage = await fetchSessionUsageForTool(tool, startedAt, {
    fallbackCost: globalDeltaCost,
    fallbackCalls: globalDeltaCalls,
  });

  if (captureMode === 'codex-summary' && sessionUsage.calls === 0) {
    const tracked = await trackCodexSummary(captured.stdout + '\n' + captured.stderr, {
      startedAt,
      latencyMs: Date.now() - startedAt,
      success: code === 0,
    });
    if (tracked) {
      costAfter = await fetchSummary();
      globalDeltaCost = (costAfter?.totalCost || 0) - (costBefore?.totalCost || 0);
      globalDeltaCalls = (costAfter?.totalCalls || 0) - (costBefore?.totalCalls || 0);
      sessionUsage = await fetchSessionUsageForTool(tool, startedAt, {
        fallbackCost: globalDeltaCost,
        fallbackCalls: globalDeltaCalls,
      });
    } else {
      console.error(`  ⚠️ Codex finished, but Tokimeter could not find a token summary to record.`);
    }
  }

  console.error(`\n  ──────────────────────────────────────────────`);
  console.error(`  💰 Session: ${sessionUsage.calls} calls | $${sessionUsage.cost.toFixed(4)}`);
  console.error(`  📊 Today:   $${(costAfter?.todayCost || 0).toFixed(2)} (${costAfter?.todayCalls || 0} calls)`);
  console.error(`  📊 Total:   $${(costAfter?.totalCost || 0).toFixed(2)} (${costAfter?.totalCalls || 0} calls)`);
  if ((costAfter?.roughEstimateCost || 0) > 0) {
    console.error(`  📎 Unpriced: rough ~$${costAfter.roughEstimateCost.toFixed(2)} excluded (${costAfter.roughEstimateCalls || 0} calls)`);
  }

  // Show top tip if available
  const tips = await fetchTips();
  if (tips && tips.length > 0 && !tips[0].includes('active')) {
    console.error(`  💡 ${tips[0]}`);
  }
  console.error(`  ──────────────────────────────────────────────\n`);

  process.exit(code || 0);
}

if (willRunPty) {
  const code = await runToolPtySession(config.detect, resolvedToolArgs, env, {
    tool,
    startedAt,
    cwd: process.cwd(),
    startupHint: overlayStartupHint,
  });
  await finishRun(code);
} else {
  inlineMonitor = shouldStartCodexInlineMonitor(tool, envVar, captureMode, toolArgs)
    ? startCodexInlineMonitor({ startedAt, cwd: process.cwd() })
    : null;

  const child = spawn(config.detect, resolvedToolArgs, {
    stdio: captureMode ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env,
  });

  if (captureMode) {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      captured.stdout = appendCaptured(captured.stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      captured.stderr = appendCaptured(captured.stderr, chunk);
    });
  }

  child.on('error', (err) => {
    console.error(`\n  ❌ Could not start ${config.detect}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', async (code) => {
    await finishRun(code);
  });
}

// ─── Helper Functions ───────────────────────────────────────────────────────

async function ensureProxyRunning(requireManualTracking = false, requireCallMetadata = false) {
  const healthy = await checkProxyHealth();
  if (healthy) {
    const supportsManualTracking = !requireManualTracking || await checkManualTrackingSupport();
    const supportsCallMetadata = !requireCallMetadata || await checkCallMetadataSupport();
    if (supportsManualTracking && supportsCallMetadata) {
      return true;
    }

    console.error(`  Existing Tokimeter proxy is stale; restarting it with current tracking support.`);
    await stopProxy();
    await sleep(500);
    if (!(await checkProxyHealth())) {
      console.error(`  Restarting Tokimeter proxy with current code...`);
    } else {
      console.error(`  ❌ A stale proxy is still listening at ${PROXY_URL}. Stop it, then retry.`);
      return false;
    }
  }

  console.error(`  Starting Tokimeter proxy...`);
  await startProxy(false);

  // Wait for it to be ready
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (await checkProxyHealth()) {
      console.error(`  ✓ Proxy running at ${PROXY_URL}\n`);
      return true;
    }
  }

  console.error(`  ❌ Proxy didn't start in time.`);
  console.error(`     Start it manually: tokimeter-proxy\n`);
  return false;
}

async function startProxy(foreground) {
  ensureDataDir();
  const serverPath = new URL('./server.js', import.meta.url).pathname;

  if (foreground) {
    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
      env: process.env,
    });
    return new Promise((resolve) => {
      child.on('exit', code => process.exit(code || 0));
      child.on('error', err => {
        console.error(`  ❌ Failed to start proxy: ${err.message}`);
        resolve(false);
      });
    });
  }

  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TOKIMETER_CONSOLE: '0', // suppress proxy's own console output
    },
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  return true;
}

async function stopProxy() {
  let stopped = false;

  if (!existsSync(PID_FILE)) {
    console.log('  Proxy is not running (no PID file).');
  } else {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  ✓ Proxy stopped (PID ${pid})`);
      stopped = true;
    } catch {
      console.log('  Proxy was not running.');
    }

    // Clean up PID file
    try { unlinkSync(PID_FILE); } catch {}
  }

  if (!stopped) {
    const pids = findListeningPids(PROXY_PORT);
    if (pids.length > 0) {
      for (const pid of pids) {
        if (pid === process.pid) continue;
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`  ✓ Proxy listener stopped on port ${PROXY_PORT} (PID ${pid})`);
          stopped = true;
        } catch {
          console.log(`  ⚠️ Could not stop listener on port ${PROXY_PORT} (PID ${pid}).`);
        }
      }

      if (stopped) {
        await waitForProxyToStop();
      }
    }
  }

  if (!stopped && findListeningPids(PROXY_PORT).length > 0) {
    console.log(`  ⚠️ A process is still listening at ${PROXY_URL}, but Tokimeter could not stop it automatically.`);
  }
}

function findListeningPids(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map(line => parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function waitForProxyToStop() {
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    if (!(await checkProxyHealth())) return true;
  }
  return false;
}

async function setupTool(setupArgs) {
  const target = setupArgs.find(arg => !arg.startsWith('-')) || 'all';
  const auto = setupArgs.includes('--auto') || setupArgs.includes('--shims');
  const dryRun = setupArgs.includes('--dry-run');
  const claudeSpinner = setupArgs.includes('--spinner') || process.env.TOKIMETER_CLAUDE_SPINNER === '1';
  let claudeStatus = null;
  const supportedTargets = ['all', 'codex', 'codex-api', 'codex-chatgpt', 'claude', 'cursor', 'grok'];
  const allTargets = target === 'all'
    ? ['codex', 'claude']
    : target === 'codex-api' || target === 'codex-chatgpt'
      ? ['codex']
      : [target];

  if (!supportedTargets.includes(target)) {
    console.error(`  ❌ Unknown setup target: ${target}`);
    console.error(`     Use: tm setup --auto, tm setup claude --auto, tm setup codex --auto, tm setup cursor, tm setup grok, tm setup codex-api, or tm setup codex-chatgpt`);
    process.exitCode = 1;
    return;
  }

  printSetupPlan(buildSetupPlan({ target, auto, claudeSpinner }), { dryRun });
  if (dryRun) return;

  if (target === 'all' || target === 'codex') {
    await ensureCodexProfiles();
    console.log(`  ✓ Codex API-key profile written: ${CODEX_API_PROFILE}`);
    console.log(`  ✓ Codex ChatGPT subscription mode uses your normal Codex login`);
    console.log(`    Daily use after setup: codex`);
    console.log(`    Explicit modes if needed: tm codex-api ... / tm codex-chatgpt ...`);
  }

  if (target === 'all' || target === 'claude') {
    claudeStatus = ensureClaudeStatusline({ spinner: claudeSpinner });
    console.log(`  ${claudeStatus.ok ? '✓' : '⚠️'} Claude status line ${claudeStatus.detail}`);
    if (claudeSpinner && claudeStatus.ok) {
      console.log(`  ✓ Claude spinner verbs enabled for Tokimeter thinking-time hints`);
    }
    console.log(`    Daily use after setup: claude`);
    console.log(`    Manual API mode if needed: export ANTHROPIC_BASE_URL=${PROXY_URL}`);
  }

  if (target === 'codex-api' || target === 'codex-chatgpt') {
    await ensureCodexProfiles();
    console.log(`  ✓ Codex setup refreshed.`);
  }

  if (target === 'cursor') {
    const cursorStatus = ensureCursorInline();
    console.log(`  ${cursorStatus.ok ? '✓' : '⚠️'} Cursor inline HUD ${cursorStatus.detail}`);
    if (cursorStatus.ok) {
      console.log(`    Status line + per-turn usage capture are active in cursor-agent.`);
      console.log(`    Usage lands in reports as --tool cursor after your next Cursor turn.`);
      console.log(`    5h budget warning: tokimeter config set budget.cursor5h 25`);
    }
  }

  if (target === 'grok') {
    const grokStatus = ensureGrokPulseHook();
    console.log(`  ${grokStatus.ok ? '✓' : '⚠️'} Grok budget pulse ${grokStatus.detail}`);
    if (grokStatus.ok) {
      console.log(`    Desktop notification when a Grok turn ends past 80% / 100% of your 5h budget.`);
      console.log(`    Set the budget: tokimeter config set budget.grok5h 10`);
    }
  }

  if (auto) {
    installShims(allTargets);
    const ptyStatus = ensureNodePtySpawnHelperExecutable();
    const rcFile = ensureShimPathInShellRc();
    console.log(`  ✓ Auto shims installed in ${SHIM_BIN_DIR}`);
    if (rcFile) {
      console.log(`  ✓ PATH configured in ${rcFile}`);
      console.log(`    Restart your terminal or run: export PATH="${SHIM_BIN_DIR}:$PATH"`);
    } else {
      console.log(`  ⚠️ Could not detect a shell rc file to update.`);
      console.log(`    Add this manually: export PATH="${SHIM_BIN_DIR}:$PATH"`);
    }
    await runAutoSetupPostflight({ targets: allTargets, ptyStatus, rcFile, claudeStatus });
  } else if (target !== 'cursor') {
    // Cursor needs no shim — the status line + hook route through cursor-agent itself.
    console.log(`  Tip: run "tokimeter setup ${target} --auto" to make normal ${allTargets.join('/')} commands route through Tokimeter.`);
  }
  console.log(`  Revert these setup changes with: tokimeter uninstall`);
}

function buildSetupPlan({ target, auto, claudeSpinner }) {
  const actions = [];
  const add = (action, path, detail = '') => actions.push({ action, path, detail });

  if (target === 'all' || target === 'codex' || target === 'codex-api' || target === 'codex-chatgpt') {
    add('back up if needed', CODEX_PROFILES_PREV, 'prior Codex profile contents, once');
    add('write', CODEX_API_PROFILE, 'Tokimeter localhost API-key profile');
    add('write', CODEX_CHATGPT_PROFILE, 'subscription-mode usage note');
  }
  if (target === 'all' || target === 'claude') {
    add('back up if needed', CLAUDE_STATUSLINE_PREV, 'existing status line and spinner settings');
    add('write', CLAUDE_STATUSLINE_SCRIPT, 'local metadata-only status-line script');
    add('update', CLAUDE_SETTINGS_FILE, `Tokimeter status line${claudeSpinner ? ' and spinner hints' : ''}`);
  }
  if (target === 'cursor') {
    add('back up if needed', CURSOR_STATUSLINE_PREV, 'existing Cursor status line');
    add('write', CURSOR_STATUSLINE_SCRIPT, 'local metadata-only status-line script');
    add('update', CURSOR_CLI_CONFIG, 'Tokimeter status line');
    add('update', CURSOR_HOOKS_FILE, 'additive stop/subagentStop usage hooks');
  }
  if (target === 'grok') {
    add('write', GROK_HOOK_FILE, 'Tokimeter-owned Stop hook for local budget notifications');
  }
  if (auto) {
    const shimTargets = target === 'all'
      ? ['tokimeter', 'tm', 'codex', 'claude']
      : ['tokimeter', 'tm', ...(target === 'codex' || target === 'codex-api' || target === 'codex-chatgpt' ? ['codex'] : []), ...(target === 'claude' ? ['claude'] : [])];
    for (const command of shimTargets) add('write', join(SHIM_BIN_DIR, command), 'generated shell shim');
    const rcFile = detectShellRcFile();
    if (rcFile) add('update if needed', rcFile, `append marked PATH block for ${SHIM_BIN_DIR}`);
    add('inspect/repair if needed', 'optional node-pty spawn helper', 'executable bit only; no download');
    add('start if needed', PROXY_URL, 'localhost process for post-setup verification');
  }
  return actions;
}

function printSetupPlan(actions, { dryRun = false } = {}) {
  console.log(`\n  Tokimeter Setup ${dryRun ? 'Dry Run' : 'Plan'}`);
  console.log(`  ──────────────────────────────────────────────`);
  if (actions.length === 0) {
    console.log(`  No file changes planned.`);
  } else {
    for (const item of actions) {
      console.log(`  • ${item.action}: ${item.path}${item.detail ? ` — ${item.detail}` : ''}`);
    }
  }
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  ${dryRun ? 'No files, processes, or settings were changed.' : 'Applying this plan now.'}`);
  console.log(`  Revert setup changes with: tokimeter uninstall\n`);
}

async function runAutoSetupPostflight({ targets, ptyStatus, rcFile, claudeStatus }) {
  console.log(`\n  Verifying Tokimeter setup...`);
  const proxyReady = await ensureProxyRunning(false, true);
  const cleanPath = stripShimDirFromPath(process.env.PATH || '');
  const realCodex = targets.includes('codex') ? commandPath('codex', cleanPath) : '';
  const realClaude = targets.includes('claude') ? commandPath('claude', cleanPath) : '';

  console.log(`\n  Tokimeter Setup`);
  console.log(`  ──────────────────────────────────────────────`);
  printDoctorLine('Proxy', proxyReady, proxyReady ? `running at ${PROXY_URL}` : `not reachable at ${PROXY_URL}`);
  printDoctorLine('PTY overlay', ptyStatus.ok, ptyStatus.detail);
  printDoctorLine('tokimeter command', isShimInstalled('tokimeter'), shimStatus('tokimeter'));
  printDoctorLine('tm command', isShimInstalled('tm'), shimStatus('tm'));
  if (targets.includes('codex')) {
    printDoctorLine('Codex shim', isShimInstalled('codex'), shimStatus('codex'));
    printDoctorLine('Real codex', Boolean(realCodex), realCodex || 'not found outside Tokimeter shims');
  }
  if (targets.includes('claude')) {
    printDoctorLine('Claude shim', isShimInstalled('claude'), shimStatus('claude'));
    printDoctorLine('Real claude', Boolean(realClaude), realClaude || 'not found outside Tokimeter shims');
    printDoctorLine('Claude status', claudeStatus?.ok === true || isClaudeStatuslineInstalled(), claudeStatus?.detail || claudeStatuslineStatus());
  }
  printDoctorLine('PATH update', Boolean(rcFile || isShimPathActive()), isShimPathActive()
    ? `${SHIM_BIN_DIR} is active now`
    : rcFile
      ? `configured in ${rcFile}; restart terminal`
      : `add ${SHIM_BIN_DIR} to PATH`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`\n  Daily use after restart:`);
  if (targets.includes('codex')) console.log(`    codex`);
  if (targets.includes('claude')) console.log(`    claude`);
  console.log(`\n  Helpful checks:`);
  console.log(`    tokimeter ready`);
  console.log(`    tokimeter doctor`);
  console.log(`    tokimeter watch --once  # diagnostic snapshot`);
  console.log('');
}

function installShims(targets) {
  ensureDataDir();
  mkdirSync(SHIM_BIN_DIR, { recursive: true });

  writeCliShim('tokimeter');
  writeCliShim('tm');

  for (const target of targets) {
    if (target === 'codex') {
      writeShim('codex', 'codex');
    } else if (target === 'claude') {
      writeShim('claude', 'claude');
    }
  }
}

function writeShim(commandName, toolName) {
  const shimPath = join(SHIM_BIN_DIR, commandName);
  const script = `#!/bin/sh
# Generated by Tokimeter. Remove with: rm "${shimPath}"
TOKIMETER_SHIM_TOOL="${toolName}" exec node "${CLI_PATH}" "${toolName}" "$@"
`;
  writeFileSync(shimPath, script, { mode: 0o755 });
}

function writeCliShim(commandName) {
  const shimPath = join(SHIM_BIN_DIR, commandName);
  const script = `#!/bin/sh
# Generated by Tokimeter. Remove with: tokimeter uninstall
exec node "${CLI_PATH}" "$@"
`;
  writeFileSync(shimPath, script, { mode: 0o755 });
}

function ensureClaudeStatusline({ spinner = false } = {}) {
  try {
    ensureDataDir();
    mkdirSync(CLAUDE_HOME, { recursive: true });

    const settings = readClaudeSettings();
    if (!settings.ok) return settings;

    writeClaudeStatuslineScript();
    const current = settings.value.statusLine;
    const currentSpinner = settings.value.spinnerVerbs;
    if (!existsSync(CLAUDE_STATUSLINE_PREV)) {
      const prev = {};
      if (current && !isTokimeterClaudeStatusline(current)) prev.statusLine = current;
      if (currentSpinner && !isTokimeterClaudeSpinner(currentSpinner)) prev.spinnerVerbs = currentSpinner;
      if (Object.keys(prev).length > 0) {
        writeFileSync(CLAUDE_STATUSLINE_PREV, JSON.stringify(prev, null, 2));
      }
    }

    settings.value.statusLine = tokimeterClaudeStatuslineValue();
    if (spinner) {
      settings.value.spinnerVerbs = tokimeterClaudeSpinnerValue();
    } else if (isTokimeterClaudeSpinner(settings.value.spinnerVerbs)) {
      delete settings.value.spinnerVerbs;
    }
    writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings.value, null, 2) + '\n');
    return { ok: true, detail: `configured in ${CLAUDE_SETTINGS_FILE}${spinner ? ' with spinner hints' : ''}` };
  } catch (err) {
    return { ok: false, detail: `not configured: ${err.message}` };
  }
}

function readClaudeSettings() {
  if (!existsSync(CLAUDE_SETTINGS_FILE)) return { ok: true, value: {} };
  try {
    const raw = readFileSync(CLAUDE_SETTINGS_FILE, 'utf8').trim();
    return { ok: true, value: raw ? JSON.parse(raw) : {} };
  } catch (err) {
    return { ok: false, detail: `not configured: ${CLAUDE_SETTINGS_FILE} is not parseable JSON (${err.message})` };
  }
}

function tokimeterClaudeStatuslineValue() {
  return {
    type: 'command',
    command: `node ${JSON.stringify(CLAUDE_STATUSLINE_SCRIPT)}`,
    padding: 0,
  };
}

function tokimeterClaudeSpinnerValue() {
  return {
    mode: 'replace',
    verbs: [
      'Tokimeter: checking spend',
      'Tokimeter: watching token use',
      'Tokimeter: looking for savings',
      'Tokimeter: no extra model calls',
    ],
  };
}

function isTokimeterClaudeStatusline(value) {
  return Boolean(value && typeof value === 'object'
    && value.type === 'command'
    && typeof value.command === 'string'
    && value.command.includes(CLAUDE_STATUSLINE_SCRIPT));
}

function isTokimeterClaudeSpinner(value) {
  return Boolean(value && typeof value === 'object'
    && value.mode === 'replace'
    && Array.isArray(value.verbs)
    && value.verbs.some(verb => String(verb).includes('Tokimeter')));
}

function writeClaudeStatuslineScript() {
  const script = `#!/usr/bin/env node
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const PROXY_URL = ${JSON.stringify(PROXY_URL)};
const PREV_PATH = ${JSON.stringify(CLAUDE_STATUSLINE_PREV)};
const SETTINGS_PATH = ${JSON.stringify(SETTINGS_FILE)};
const CLI_PATH = ${JSON.stringify(CLI_PATH)};
const TIMEOUT_MS = 300;
const IMPORT_TIMEOUT_MS = 700;

function getJSON(path) {
  return new Promise((resolve) => {
    const req = http.get(PROXY_URL + path, { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readPrevStatuslineCommand() {
  try {
    if (!existsSync(PREV_PATH)) return '';
    const value = JSON.parse(readFileSync(PREV_PATH, 'utf8')).statusLine;
    if (!value || value.type !== 'command' || typeof value.command !== 'string') return '';
    if (value.command.includes('claude-statusline.mjs')) return '';
    return value.command;
  } catch {
    return '';
  }
}

// Claude Code pipes session context (session_id, cwd, model, ...) to the
// status line command on stdin.
function readStdinSession() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let body = '';
    const timer = setTimeout(() => resolve(parseSession(body)), TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(parseSession(body)); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function parseSession(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// Session budgets (budget.session.cost / budget.session.minutes) — warn in
// the HUD once this Claude session crosses either. Informational only.
function sessionBudgetText(calls, session) {
  const sessionId = session?.session_id || session?.sessionId || '';
  if (!sessionId) return '';

  let cost = Number(process.env.TOKIMETER_SESSION_COST_BUDGET || 0);
  let minutes = Number(process.env.TOKIMETER_SESSION_MINUTES_BUDGET || 0);
  if (!(cost > 0) || !(minutes > 0)) {
    try {
      const budget = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))?.budget?.session || {};
      if (!(cost > 0)) cost = Number(budget.cost || 0);
      if (!(minutes > 0)) minutes = Number(budget.minutes || 0);
    } catch {
      // No settings file — session budgets stay off.
    }
  }
  if (!(cost > 0) && !(minutes > 0)) return '';

  const sessionCalls = calls.filter((call) => call.sessionId === sessionId);
  if (sessionCalls.length === 0) return '';
  const sessionCost = sessionCalls.reduce((sum, call) => sum + (Number(call.totalCost) || 0), 0);
  const startedAt = Math.min(...sessionCalls.map((call) => Number(call.timestamp) || Date.now()));
  const elapsedMinutes = Math.round((Date.now() - startedAt) / 60000);

  const parts = [];
  if (cost > 0 && sessionCost >= cost * 0.8) {
    parts.push(\`~$\${sessionCost.toFixed(2)}\${sessionCost >= cost ? ' ⚠ over' : ' near'} $\${cost.toFixed(2)} session budget\`);
  }
  if (minutes > 0 && elapsedMinutes >= minutes) {
    parts.push(\`\${elapsedMinutes}m ⚠ over \${minutes}m\`);
  }
  return parts.length ? \` · session \${parts.join(' · ')}\` : '';
}

async function importRecentClaudeUsage() {
  try {
    const { spawn } = await import('node:child_process');
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        CLI_PATH,
        'claude-import',
        '--since-minutes=10',
        '--limit=12',
        '--quiet',
      ], {
        stdio: 'ignore',
        env: {
          ...process.env,
          TOKIMETER_STATUSLINE_IMPORT: '1',
        },
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, IMPORT_TIMEOUT_MS);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    // The status line should never fail because import is unavailable.
  }
}

async function main() {
  const sessionPromise = readStdinSession();
  await importRecentClaudeUsage();
  const summary = await getJSON('/api/summary');
  const callsData = await getJSON('/api/calls?limit=500');
  const calls = Array.isArray(callsData) ? callsData : (Array.isArray(callsData?.calls) ? callsData.calls : []);
  const claudeUsageCalls = calls.filter((call) => isClaudeCall(call) && isUsageCall(call));
  const todayCostNum = todayCostFor(claudeUsageCalls);
  const estimated = claudeUsageCalls.some((call) => String(call.source || '').startsWith('claude-transcript'));
  const todayCost = (estimated ? '~$' : '$') + todayCostNum.toFixed(2);
  const fiveHourMs = Date.now() - 5 * 3600 * 1000;
  const fiveHourCost = claudeUsageCalls
    .filter((call) => Number(call.timestamp || 0) >= fiveHourMs)
    .reduce((sum, call) => sum + (Number(call.totalCost) || 0), 0);
  let fiveHourBudget = Number(process.env.TOKIMETER_CLAUDE_5H_BUDGET || 0);
  if (!(fiveHourBudget > 0)) {
    try {
      fiveHourBudget = Number(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))?.budget?.claude5h || 0);
    } catch {
      // No settings file — budget stays off.
    }
  }
  const fiveHourPct = fiveHourBudget > 0 ? Math.round((fiveHourCost / fiveHourBudget) * 100) : 0;
  const fiveHourText = \` · 5h \${estimated ? '~$' : '$'}\${fiveHourCost.toFixed(2)}\${fiveHourBudget > 0 ? \` (\${fiveHourPct}%\${fiveHourPct >= 80 ? ' ⚠' : ''})\` : ''}\`;
  const todayCalls = todayCallsFor(claudeUsageCalls);
  const savings = estimateSavingsToday(claudeUsageCalls);
  const latest = latestCall(claudeUsageCalls);
  const mode = process.env.TOKIMETER_CLAUDE_HUD || 'savings';
  const tip = claudeHudTip({ savings, latest });
  const session = await sessionPromise;
  const sessionText = summary ? sessionBudgetText(claudeUsageCalls, session) : '';
  const line = summary
    ? formatHudLine({ mode, todayCost, todayCalls, savings, latest, tip, fiveHourText }) + sessionText
    : 'Tokimeter offline · start with tokimeter setup --auto';

  process.stdout.write(line);

  const previous = readPrevStatuslineCommand();
  if (previous) {
    process.stdout.write('\\n');
    const { spawn } = await import('node:child_process');
    await new Promise((resolve) => {
      const child = spawn(previous, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 500);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => {
        clearTimeout(timer);
        process.stdout.write(out.replace(/[\\r\\n]+$/, '').slice(0, 300));
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function formatHudLine({ mode, todayCost, todayCalls, savings, latest, tip, fiveHourText }) {
  if (mode === 'compact') {
    return \`Tokimeter Claude \${todayCost} today\${fiveHourText} · \${todayCalls} calls\`;
  }
  if (mode === 'budget') {
    const budget = Number(process.env.TOKIMETER_DAILY_BUDGET || 0);
    const pct = budget > 0 ? Math.round((Number(String(todayCost).replace(/[~$]/g, '')) / budget) * 100) : 0;
    return budget > 0
      ? \`Tokimeter Claude budget \${pct}% · \${todayCost}/$\${budget.toFixed(2)} today · \${todayCalls} calls\`
      : \`Tokimeter Claude today \${todayCost} · set TOKIMETER_DAILY_BUDGET for budget HUD\`;
  }
  if (mode === 'latest') {
    return latest
      ? \`Tokimeter Claude latest \${latest.model || 'unknown'} · \${Number(latest.roughEstimateCost || 0) > 0 ? 'unpriced (rough ~$' + Number(latest.roughEstimateCost).toFixed(4) + ' excluded)' : '$' + Number(latest.totalCost || 0).toFixed(4)} · today \${todayCost}\`
      : \`Tokimeter Claude today \${todayCost} · waiting for Claude calls\`;
  }
  const saved = savings.saved > 0 ? \` · ~$\${savings.saved.toFixed(2)} under baseline\` : '';
  const latestText = latest?.model ? \` · latest \${latest.model}\${latest.effort ? ' ' + latest.effort : ''}\` : '';
  return \`Tokimeter Claude today \${todayCost}\${fiveHourText} / \${todayCalls} calls\${saved}\${latestText} · \${tip}\`;
}

function latestCall(calls) {
  return calls
    .filter((call) => Number(call.timestamp || 0) >= todayStartMs())
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0] || null;
}

function isClaudeCall(call) {
  return call?.tool === 'claude-code' || call?.provider === 'anthropic';
}

function isUsageCall(call) {
  const totalCost = Number(call?.totalCost || 0);
  const tokens = Number(call?.inputTokens || 0)
    + Number(call?.outputTokens || 0)
    + Number(call?.cachedTokens || 0)
    + Number(call?.reasoningTokens || 0);
  return totalCost > 0 || tokens > 0;
}

function todayCostFor(calls) {
  return calls
    .filter((call) => Number(call.timestamp || 0) >= todayStartMs())
    .reduce((sum, call) => sum + (Number(call.totalCost) || 0), 0);
}

function todayCallsFor(calls) {
  return calls.filter((call) => Number(call.timestamp || 0) >= todayStartMs()).length;
}

function claudeHudTip({ savings, latest }) {
  if (!latest) return 'no Claude usage yet';
  const model = String(latest.model || '').toLowerCase();
  if (model.includes('haiku')) return 'lower-cost Claude model detected';
  if (model.includes('opus')) return 'use Opus for hard work; Sonnet/Haiku can reduce spend';
  if (model.includes('sonnet')) return 'use Haiku for simple prompts; keep Sonnet for code work';
  if (savings.saved > 0) return 'Claude savings estimate is local only';
  return 'Claude tracking only; no extra model calls';
}

function estimateSavingsToday(calls) {
  let actual = 0;
  let baseline = 0;
  for (const call of calls) {
    if (Number(call.timestamp || 0) < todayStartMs()) continue;
    const cost = Number(call.totalCost || 0);
    actual += cost;
    baseline += estimatedBaselineCost(call, cost);
  }
  return { actual, baseline, saved: Math.max(0, baseline - actual) };
}

function estimatedBaselineCost(call, actualCost) {
  const model = String(call.model || '').toLowerCase();
  const effort = String(call.effort || '').toLowerCase();
  let multiplier = 1;
  if (model.includes('haiku')) multiplier = 3.5;
  else if (model.includes('mini') || model.includes('nano')) multiplier = 2.8;
  else if (model.includes('sonnet')) multiplier = 1.5;
  if (effort === 'low') multiplier = Math.max(multiplier, 1.8);
  return actualCost * multiplier;
}

function todayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

main().catch(() => process.exit(0));
`;
  writeFileSync(CLAUDE_STATUSLINE_SCRIPT, script, { mode: 0o755 });
}

function isClaudeStatuslineInstalled() {
  const settings = readClaudeSettings();
  return Boolean(settings.ok && isTokimeterClaudeStatusline(settings.value.statusLine) && existsSync(CLAUDE_STATUSLINE_SCRIPT));
}

function claudeStatuslineStatus() {
  const settings = readClaudeSettings();
  if (!settings.ok) return settings.detail;
  if (isTokimeterClaudeStatusline(settings.value.statusLine)) {
    const spinner = isTokimeterClaudeSpinner(settings.value.spinnerVerbs) ? ' + spinner hints' : '';
    return existsSync(CLAUDE_STATUSLINE_SCRIPT)
      ? `configured in ${CLAUDE_SETTINGS_FILE}${spinner}`
      : `settings point to missing ${CLAUDE_STATUSLINE_SCRIPT}; run tokimeter setup claude --auto`;
  }
  return `not configured; run tokimeter setup claude --auto`;
}

function ensureShimPathInShellRc() {
  const rcFile = detectShellRcFile();
  if (!rcFile) return '';

  const existing = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
  if (existing.includes(AUTO_PATH_START) || existing.includes(SHIM_BIN_DIR)) {
    return rcFile;
  }

  const block = `
${AUTO_PATH_START}
export PATH="${SHIM_BIN_DIR}:$PATH"
${AUTO_PATH_END}
`;
  appendFileSync(rcFile, block);
  return rcFile;
}

function detectShellRcFile() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  if (shell.includes('fish')) return '';

  const zshrc = join(homedir(), '.zshrc');
  const bashrc = join(homedir(), '.bashrc');
  if (existsSync(zshrc)) return zshrc;
  if (existsSync(bashrc)) return bashrc;
  return zshrc;
}

function stripShimDirFromPath(pathValue) {
  return pathValue
    .split(':')
    .filter(entry => entry && entry !== SHIM_BIN_DIR)
    .join(':');
}

function isCodexExec(args) {
  return args[0] === 'exec';
}

function isCodexChatGptMode(tool, envVar, captureMode) {
  return (tool === 'codex' || tool === 'codex-chatgpt')
    && !envVar
    && captureMode !== 'codex-summary';
}

function isLikelyCodexInteractiveArgs(args) {
  const nonInteractive = new Set(['--help', '-h', 'help', '--version', '-V', 'version']);
  return args.length === 0 || !nonInteractive.has(args[0]);
}

function isLikelyClaudeInteractiveArgs(args) {
  const nonInteractive = new Set(['--help', '-h', 'help', '--version', '-v', 'version']);
  return args.length === 0 || !nonInteractive.has(args[0]);
}

function shouldStartCodexInlineMonitor(tool, envVar, captureMode, args = []) {
  return process.env.TOKIMETER_INLINE !== '0'
    && isLikelyCodexInteractiveArgs(args)
    && isCodexChatGptMode(tool, envVar, captureMode);
}

function shouldRunCodexPty(tool, envVar, captureMode, args) {
  return process.env.TOKIMETER_PTY !== '0'
    && process.stdin.isTTY
    && process.stdout.isTTY
    && isLikelyCodexInteractiveArgs(args)
    && isCodexChatGptMode(tool, envVar, captureMode);
}

function shouldRunClaudePty(tool, args) {
  return process.env.TOKIMETER_PTY !== '0'
    && process.stdin.isTTY
    && process.stdout.isTTY
    && tool === 'claude'
    && args.length === 0;
}

async function runToolPtySession(command, args, env, meta) {
  let pty;
  try {
    ensureNodePtySpawnHelperExecutable();
    pty = await import('node-pty');
  } catch {
    console.error(`  Tokimeter PTY overlay unavailable: install optional dependency "node-pty".`);
    console.error(`  Falling back to normal ${meta.tool} terminal mode.\n`);
    inlineMonitor = shouldStartCodexInlineMonitor(meta.tool, null, null, args)
      ? startCodexInlineMonitor({ ...meta, display: displayCodexTitleOnly })
      : null;
    return runInheritedTool(command, args, env);
  }

  const resolvedCommand = commandPath(command, env.PATH || process.env.PATH || '') || command;
  return runPtyTool(pty, resolvedCommand, args, env, meta, command);
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.env.TOKIMETER_PTY === '0') {
    return { ok: false, detail: 'disabled by TOKIMETER_PTY=0' };
  }
  if (process.platform !== 'darwin') {
    return { ok: true, detail: 'available when optional node-pty loads' };
  }

  try {
    const packagePath = require.resolve('node-pty/package.json');
    const helperPath = join(dirname(packagePath), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const helperStat = statSync(helperPath);
    if ((helperStat.mode & 0o111) === 0) {
      chmodSync(helperPath, helperStat.mode | 0o755);
      return { ok: true, detail: `repaired ${helperPath}` };
    }
    return { ok: true, detail: `ready at ${helperPath}` };
  } catch (err) {
    return { ok: false, detail: `not ready: ${err.message}` };
  }
}

function runInheritedTool(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', (err) => {
      console.error(`\n  ❌ Could not start ${command}: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code || 0));
  });
}

function runPtyTool(pty, command, args, env, meta, fallbackCommand = command) {
  return new Promise((resolve) => {
    const overlay = createCodexOverlay();
    let promptAdvisor = null;
    let child;
    const toolName = meta.tool;

    try {
      child = pty.spawn(command, args, {
        name: process.env.TERM || 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd: process.cwd(),
        env,
      });
    } catch (err) {
      console.error(`  Tokimeter PTY overlay failed to start: ${err.message}`);
      console.error(`  Falling back to normal ${toolName} terminal mode.\n`);
      inlineMonitor = shouldStartCodexInlineMonitor(toolName, null, null, args)
        ? startCodexInlineMonitor({ ...meta, display: displayCodexTitleOnly })
        : null;
      runInheritedTool(fallbackCommand, args, env).then(resolve);
      return;
    }

    const onInput = (chunk) => {
      if (promptAdvisor && promptAdvisor.handleInput(chunk)) {
        return;
      }
      child.write(chunk);
    };
    const onResize = () => {
      try {
        child.resize(process.stdout.columns || 80, process.stdout.rows || 24);
      } catch {}
      overlay.redrawSoon();
    };

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onInput);
    process.stdout.on('resize', onResize);

    inlineMonitor = createPtyInlineMonitor(toolName, {
      ...meta,
      display: (call) => overlay.show(formatInlineCallMessage(call)),
      notify: (text) => overlay.show({ call: {}, title: `Tokimeter ⚠ ${text}`, body: `⚠ ${text}` }),
    });
    if (shouldShowStartupOverlay(toolName)) {
      overlay.show(formatStartupOverlayMessage(toolName, meta.startupHint));
    }
    promptAdvisor = createPtyPromptAdvisor({ toolName, child, overlay });

    child.onData((data) => {
      process.stdout.write(data);
      if (promptAdvisor) promptAdvisor.observeOutput(data);
      overlay.redrawSoon();
    });

    child.onExit(async ({ exitCode }) => {
      process.stdin.off('data', onInput);
      process.stdout.off('resize', onResize);
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw));
      overlay.clear();
      resolve(exitCode || 0);
    });
  });
}

function createPtyInlineMonitor(toolName, meta) {
  if (toolName === 'codex' || toolName === 'codex-chatgpt') {
    return startCodexInlineMonitor(meta);
  }
  if (toolName === 'claude') {
    return startClaudeInlineMonitor(meta);
  }
  return null;
}

function shouldShowStartupOverlay(toolName) {
  if (toolName === 'claude') {
    return process.env.TOKIMETER_CLAUDE_STARTUP_OVERLAY === '1';
  }
  return true;
}

function formatInlineCallMessage(call) {
  if (call.provider === 'anthropic' || call.tool === 'claude-code') {
    return formatClaudeInlineMessage(call);
  }
  return formatCodexInlineMessage(call);
}

function formatStartupOverlayMessage(toolName, startupHint) {
  if (toolName === 'claude') {
    return formatClaudeStartupOverlayMessage(startupHint);
  }
  return formatCodexStartupOverlayMessage(startupHint);
}

function createPtyPromptAdvisor({ toolName, child, overlay }) {
  if (toolName === 'claude') {
    return createClaudePromptAdvisor({ child, overlay });
  }
  return createCodexPromptAdvisor({ child, overlay });
}

function startCodexInlineMonitor({ startedAt, cwd, display = displayCodexTitleOnly, notify = notifySessionBudgetFallback }) {
  let stopped = false;
  const printed = new Set();
  const sessionBudget = createSessionBudgetTracker({ startedAt, notify });

  const tick = async () => {
    if (stopped) return;

    await importCodexRolloutTokenCounts({
      verbose: false,
      limit: 12,
      sinceMs: startedAt - 5000,
      onRecorded: (call) => {
        if (stopped || !isCodexInlineCallForRun(call, { startedAt, cwd })) return;

        const id = call.externalId || `${call.timestamp}-${call.model}-${call.totalCost}`;
        if (printed.has(id)) return;
        printed.add(id);
        sessionBudget.onCall(call);
        display(call);
      },
    });
  };

  const timer = setInterval(tick, 3000);
  return {
    async stop() {
      await tick();
      stopped = true;
      clearInterval(timer);
      sessionBudget.stop();
    },
  };
}

// Without a PTY overlay the session-budget warning goes to stderr, which the
// wrapped tool's terminal shows between turns.
function notifySessionBudgetFallback(text) {
  console.error(`\n  ⚠ Tokimeter: ${text}\n`);
}

function startProxyCallInlineMonitor({ startedAt, display, match }) {
  let stopped = false;
  const printed = new Set();

  const tick = async () => {
    if (stopped) return;
    const calls = await fetchRecentCalls(8);
    for (const call of calls) {
      if (stopped || !call || (Number(call.timestamp) || 0) < startedAt - 5000) continue;
      if (match && !match(call)) continue;

      const id = call.externalId || `${call.timestamp}-${call.tool}-${call.model}-${call.totalCost}`;
      if (printed.has(id)) continue;
      printed.add(id);
      display(call);
    }
  };

  const timer = setInterval(tick, 3000);
  return {
    async stop() {
      await tick();
      stopped = true;
      clearInterval(timer);
    },
  };
}

function startClaudeInlineMonitor({ startedAt, cwd, display }) {
  let stopped = false;
  const printed = new Set();

  const tick = async () => {
    if (stopped) return;

    await importClaudeTranscriptUsage({
      verbose: false,
      limit: 12,
      sinceMs: startedAt - 5000,
      onRecorded: (call) => {
        if (stopped || !isClaudeInlineCallForRun(call, { startedAt, cwd })) return;

        const id = call.externalId || `${call.timestamp}-${call.model}-${call.totalCost}`;
        if (printed.has(id)) return;
        printed.add(id);
        display(call);
      },
    });
  };

  const timer = setInterval(tick, 3000);
  return {
    async stop() {
      await tick();
      stopped = true;
      clearInterval(timer);
    },
  };
}

function isCodexInlineCallForRun(call, { startedAt, cwd }) {
  if (!call || call.tool !== 'codex') return false;
  if ((Number(call.timestamp) || 0) < startedAt - 5000) return false;
  if (call.cwd && cwd && call.cwd !== cwd) return false;
  return true;
}

function isClaudeInlineCallForRun(call, { startedAt, cwd }) {
  if (!call || call.tool !== 'claude-code') return false;
  if ((Number(call.timestamp) || 0) < startedAt - 5000) return false;
  if (call.cwd && cwd && call.cwd !== cwd) return false;
  return true;
}

function displayCodexTitleOnly(call) {
  const message = formatCodexInlineMessage(call);
  writeCodexInlineLog(call, message);
  updateTerminalTitle(message.title);

  if (process.env.TOKIMETER_INLINE_BODY !== '1') {
    return;
  }

  console.error(`\n  💰 Tokimeter: ${message.body}`);

  if (message.recommendation) {
    console.error(`  💡 ${message.recommendation}`);
  }
  console.error('');
}

function createCodexOverlay() {
  let message = null;
  let timer = null;

  const render = () => {
    if (!message || !process.stdout.isTTY) return;
    const width = process.stdout.columns || 80;
    const row = process.stdout.rows || 24;
    const line = ` 💰 ${message.body}${message.recommendation ? `  |  ${message.recommendation}` : ''} `;
    const text = truncateAnsiSafe(line, Math.max(20, width - 1));

    process.stdout.write('\x1b7');
    process.stdout.write(`\x1b[${row};1H`);
    process.stdout.write('\x1b[2K');
    process.stdout.write(`\x1b[48;5;236m\x1b[38;5;230m${text.padEnd(Math.max(0, width - 1), ' ')}\x1b[0m`);
    process.stdout.write('\x1b8');
  };

  return {
    show(nextMessage) {
      message = nextMessage;
      writeCodexInlineLog(nextMessage.call || {}, nextMessage);
      updateTerminalTitle(nextMessage.title);
      render();
    },
    redrawSoon() {
      if (!message) return;
      clearTimeout(timer);
      timer = setTimeout(render, 60);
    },
    clear() {
      clearTimeout(timer);
      if (!message || !process.stdout.isTTY) return;
      const row = process.stdout.rows || 24;
      process.stdout.write('\x1b7');
      process.stdout.write(`\x1b[${row};1H\x1b[2K`);
      process.stdout.write('\x1b8');
      message = null;
    },
  };
}

function createCodexPromptAdvisor({ child, overlay }) {
  const enabled = process.env.TOKIMETER_ADVISOR !== '0';
  let promptBuffer = '';
  let pendingAdvice = null;
  let currentModel = '';
  let lastAdvisedPrompt = '';

  const resetPrompt = () => {
    promptBuffer = '';
    pendingAdvice = null;
  };

  const applySwitch = () => {
    if (!pendingAdvice) return;
    const advice = pendingAdvice;
    pendingAdvice = null;

    child.write('\x15');
    child.write(`/model ${advice.targetModel}`);
    child.write('\r');
    setTimeout(() => {
      child.write(advice.prompt);
      promptBuffer = advice.prompt;
      overlay.show(formatCodexAdvisorFollowupMessage(advice));
    }, 600);
  };

  return {
    observeOutput(data) {
      const text = data.toString('utf8');
      const bannerMatch = text.match(/model:\s+([^\r\n/]+)/i);
      if (bannerMatch) currentModel = bannerMatch[1].trim();

      const changedMatch = text.match(/Model changed to\s+([^\r\n]+)/i);
      if (changedMatch) currentModel = changedMatch[1].trim();
    },

    handleInput(chunk) {
      if (!enabled) return false;

      const text = chunk.toString('utf8');

      if (pendingAdvice) {
        if (text === '\x14') {
          applySwitch();
          return true;
        }
        if (text === '\x1b') {
          overlay.show(formatCodexAdvisorDismissedMessage(pendingAdvice));
          pendingAdvice = null;
          return true;
        }
        if (text === '\r' || text === '\n') {
          resetPrompt();
          return false;
        }
        pendingAdvice = null;
      }

      if (text === '\r' || text === '\n') {
        const prompt = promptBuffer.trim();
        const advice = buildCodexPreSubmitAdvice(prompt, currentModel);
        if (advice && prompt !== lastAdvisedPrompt) {
          pendingAdvice = advice;
          lastAdvisedPrompt = prompt;
          overlay.show(formatCodexAdvisorMessage(advice));
          return true;
        }
        resetPrompt();
        return false;
      }

      updatePromptBufferFromInput(text);
      return false;
    },
  };

  function updatePromptBufferFromInput(text) {
    if (text === '\x03') {
      resetPrompt();
      return;
    }
    if (text === '\x15') {
      promptBuffer = '';
      return;
    }
    if (text === '\x7f' || text === '\b') {
      promptBuffer = promptBuffer.slice(0, -1);
      return;
    }
    if (text.startsWith('\x1b')) {
      return;
    }

    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 32 && code !== 127) {
        promptBuffer += char;
      }
    }

    if (promptBuffer.length > 4000) {
      promptBuffer = promptBuffer.slice(-4000);
    }
  }
}

function truncateAnsiSafe(text, width) {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 2))}…`;
}

function formatCodexInlineMessage(call) {
  const effort = call.effort ? ` ${call.effort}` : '';
  const context = formatCallContext(call);
  const labels = formatCallLabels(call);
  const reasoning = call.reasoningTokens ? ` / ${call.reasoningTokens} reasoning` : '';
  const cost = Number(call.totalCost) || 0;
  const model = `${call.model || 'unknown'}${effort}`;
  const body = `${context ? `${context} · ` : ''}${model} · ${labels} · ${call.inputTokens || 0} in / ${call.outputTokens || 0} out${reasoning} · ~$${cost.toFixed(4)}`;
  const recommendation = codexInlineRecommendation(call);

  return {
    call,
    title: `Tokimeter ~$${cost.toFixed(4)} · ${model}`,
    body,
    recommendation,
  };
}

function formatClaudeInlineMessage(call) {
  const context = formatCallContext(call);
  const labels = formatCallLabels(call);
  const cached = call.cachedTokens ? ` / ${call.cachedTokens} cached` : '';
  const cost = Number(call.totalCost) || 0;
  const model = call.model || 'Claude';
  const confidence = call.confidence === 'exact' ? 'exact' : 'tracked';
  const body = `${context ? `${context} · ` : ''}${model} · ${labels} · ${call.inputTokens || 0} in / ${call.outputTokens || 0} out${cached} · $${cost.toFixed(4)} ${confidence}`;
  const recommendation = claudeInlineRecommendation(call);

  return {
    call,
    title: `Tokimeter $${cost.toFixed(4)} · ${model}`,
    body,
    recommendation,
  };
}

function formatCodexStartupOverlayMessage(startupHint) {
  return {
    call: {
      tool: 'codex',
      confidence: 'local-hint',
    },
    title: 'Tokimeter active',
    body: 'Tokimeter active · local-only savings hints · no extra tokens',
    recommendation: startupHint || 'Use /model for mini/low on simple prompts; keep stronger models for repo-wide edits and debugging.',
  };
}

function formatClaudeStartupOverlayMessage(startupHint) {
  return {
    call: {
      tool: 'claude-code',
      confidence: 'local-hint',
    },
    title: 'Tokimeter Claude advisor active',
    body: 'Claude advisor active · local-only savings hints · no extra tokens',
    recommendation: startupHint || 'Use /model haiku for simple prompts; keep Sonnet/Opus for code edits, debugging, and reviews.',
  };
}

function formatCodexAdvisorMessage(advice) {
  return {
    call: {
      tool: 'codex',
      confidence: 'local-pre-submit',
      model: advice.currentModel,
    },
    title: `Tokimeter advisor · ${advice.targetModel}`,
    body: `Advisor: ${advice.reason}`,
    recommendation: `Switch to ${advice.targetModel} to ${advice.savingsText}. Ctrl+T switch, Enter send anyway, Esc dismiss.`,
  };
}

function formatCodexAdvisorFollowupMessage(advice) {
  return {
    call: {
      tool: 'codex',
      confidence: 'local-pre-submit',
      model: advice.targetModel,
    },
    title: `Tokimeter switched · ${advice.targetModel}`,
    body: `Inserted /model ${advice.targetModel}`,
    recommendation: 'Your prompt was restored. Press Enter to send it on the lower-cost model.',
  };
}

function formatCodexAdvisorDismissedMessage(advice) {
  return {
    call: {
      tool: 'codex',
      confidence: 'local-pre-submit',
      model: advice.currentModel,
    },
    title: 'Tokimeter advisor dismissed',
    body: 'Advisor dismissed',
    recommendation: 'Press Enter to send normally. Set TOKIMETER_ADVISOR=0 to disable these prompts.',
  };
}

function createClaudePromptAdvisor({ child, overlay }) {
  const enabled = process.env.TOKIMETER_ADVISOR !== '0' && process.env.TOKIMETER_CLAUDE_ADVISOR !== '0';
  let promptBuffer = '';
  let pendingAdvice = null;
  let currentModel = process.env.TOKIMETER_CLAUDE_CURRENT_MODEL || process.env.ANTHROPIC_MODEL || '';
  let lastAdvisedPrompt = '';

  // Terminal-output sniffing is unreliable for the current model, so also learn
  // it from the session's tracked usage (latest Claude call wins).
  const refreshModelFromUsage = async () => {
    try {
      const calls = await fetchRecentCalls(50);
      const latestClaude = (Array.isArray(calls) ? calls : []).find(call => callMatchesTool(call, 'claude'));
      if (latestClaude?.model) currentModel = latestClaude.model;
    } catch {
      // Keep whatever we had; the advisor stays quiet on unknown models.
    }
  };
  refreshModelFromUsage();
  const modelRefreshTimer = setInterval(refreshModelFromUsage, 15000);
  if (typeof modelRefreshTimer.unref === 'function') modelRefreshTimer.unref();

  const resetPrompt = () => {
    promptBuffer = '';
    pendingAdvice = null;
  };

  const applySwitch = () => {
    if (!pendingAdvice) return;
    const advice = pendingAdvice;
    pendingAdvice = null;

    child.write('\x15');
    child.write(`/model ${advice.targetModel}`);
    child.write('\r');
    setTimeout(() => {
      child.write(advice.prompt);
      promptBuffer = advice.prompt;
      overlay.show(formatClaudeAdvisorFollowupMessage(advice));
    }, 600);
  };

  return {
    observeOutput(data) {
      const text = data.toString('utf8');
      const bannerMatch = text.match(/model:\s+([^\r\n/]+)/i);
      if (bannerMatch) currentModel = bannerMatch[1].trim();

      const changedMatch = text.match(/Model changed to\s+([^\r\n]+)/i)
        || text.match(/Using\s+model\s+([^\r\n]+)/i);
      if (changedMatch) currentModel = changedMatch[1].trim();
    },

    handleInput(chunk) {
      if (!enabled) return false;

      const text = chunk.toString('utf8');

      if (pendingAdvice) {
        if (text === '\x14') {
          applySwitch();
          return true;
        }
        if (text === '\x1b') {
          overlay.show(formatClaudeAdvisorDismissedMessage(pendingAdvice));
          pendingAdvice = null;
          return true;
        }
        if (text === '\r' || text === '\n') {
          resetPrompt();
          return false;
        }
        pendingAdvice = null;
      }

      if (text === '\r' || text === '\n') {
        const prompt = promptBuffer.trim();
        const advice = buildClaudePreSubmitAdvice(prompt, currentModel);
        if (advice && prompt !== lastAdvisedPrompt) {
          pendingAdvice = advice;
          lastAdvisedPrompt = prompt;
          overlay.show(formatClaudeAdvisorMessage(advice));
          return true;
        }
        resetPrompt();
        return false;
      }

      updatePromptBufferFromInput(text);
      return false;
    },
  };

  function updatePromptBufferFromInput(text) {
    if (text === '\x03') {
      resetPrompt();
      return;
    }
    if (text === '\x15') {
      promptBuffer = '';
      return;
    }
    if (text === '\x7f' || text === '\b') {
      promptBuffer = promptBuffer.slice(0, -1);
      return;
    }
    if (text.startsWith('\x1b')) {
      return;
    }

    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 32 && code !== 127) {
        promptBuffer += char;
      }
    }

    if (promptBuffer.length > 4000) {
      promptBuffer = promptBuffer.slice(-4000);
    }
  }
}

function formatClaudeAdvisorMessage(advice) {
  return {
    call: {
      tool: 'claude-code',
      confidence: 'local-pre-submit',
      model: advice.currentModel,
    },
    title: `Tokimeter advisor · Claude ${advice.targetModel}`,
    body: `Claude advisor: ${advice.reason}`,
    recommendation: `Switch to ${advice.targetModel} to ${advice.savingsText}. Ctrl+T switch, Enter send anyway, Esc dismiss.`,
  };
}

function formatClaudeAdvisorFollowupMessage(advice) {
  return {
    call: {
      tool: 'claude-code',
      confidence: 'local-pre-submit',
      model: advice.targetModel,
    },
    title: `Tokimeter switched · Claude ${advice.targetModel}`,
    body: `Inserted /model ${advice.targetModel}`,
    recommendation: 'Your prompt was restored. Press Enter to send it on the lower-cost model.',
  };
}

function formatClaudeAdvisorDismissedMessage(advice) {
  return {
    call: {
      tool: 'claude-code',
      confidence: 'local-pre-submit',
      model: advice.currentModel,
    },
    title: 'Tokimeter advisor dismissed',
    body: 'Claude advisor dismissed',
    recommendation: 'Press Enter to send normally. Set TOKIMETER_CLAUDE_ADVISOR=0 to disable these prompts.',
  };
}

function updateTerminalTitle(title) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\u001b]0;${title.replace(/\u0007/g, '')}\u0007`);
}

function writeCodexInlineLog(call, message) {
  ensureDataDir();
  const payload = {
    timestamp: Date.now(),
    callTimestamp: call.timestamp,
    tool: call.tool,
    model: call.model,
    effort: call.effort,
    totalCost: call.totalCost,
    confidence: call.confidence,
    pricingConfidence: call.pricingConfidence,
    cwd: call.cwd,
    sessionId: call.sessionId,
    title: message.title,
    body: message.body,
    recommendation: message.recommendation,
  };

  try {
    writeFileSync(join(DATA_DIR, 'inline-events.jsonl'), JSON.stringify(payload) + '\n', { flag: 'a' });
  } catch {
    // Inline notes should never break the wrapped CLI.
  }
}

function codexInlineRecommendation(call) {
  const model = String(call.model || '');
  const effort = String(call.effort || '');
  const inputTokens = Number(call.inputTokens) || 0;
  const pricingConfidence = call.pricingConfidence || getPricingSource(model).confidence;

  if (pricingConfidence === 'fallback') {
    return 'Model is unpriced; any rough fallback is excluded from priced totals. Add a current custom price to include it.';
  }

  if (model.includes('mini') || effort === 'low') {
    return 'Lower-cost model/effort detected. Tokimeter will compare savings once a high-model baseline exists.';
  }

  if (effort === 'high' && inputTokens < 20000) {
    return 'This was a relatively small high-effort turn; try mini/low for simple prompts.';
  }

  if (inputTokens > 80000) {
    return 'Large context drove this turn. A fresh session or narrower prompt may save more than switching models.';
  }

  return '';
}

function claudeInlineRecommendation(call) {
  const model = String(call.model || '').toLowerCase();
  const inputTokens = Number(call.inputTokens) || 0;
  const pricingConfidence = call.pricingConfidence || getPricingSource(call.model).confidence;

  if (pricingConfidence === 'fallback') {
    return 'Claude model is unpriced; any rough fallback is excluded from priced totals. Add a current custom price to include it.';
  }

  if (model.includes('haiku')) {
    return 'Lower-cost Claude model detected. Tokimeter will compare savings against Sonnet/Opus baselines.';
  }

  if ((model.includes('sonnet') || model.includes('opus')) && inputTokens < 10000) {
    return 'Small Claude turn on a stronger model; try Haiku for simple questions and short rewrites.';
  }

  if (inputTokens > 80000) {
    return 'Large context drove this Claude turn. A narrower prompt or fresh session may save more than switching models.';
  }

  return '';
}

function getPreflightHint(tool, args) {
  if (tool === 'claude') {
    const prompt = extractClaudePrompt(args);
    if (!prompt) return '';
    const classification = classifyAdvisorPrompt(prompt);
    if (classification.kind === 'simple') {
      return 'This looks like a simple Claude prompt. Haiku may be enough; keep Sonnet/Opus for code edits, debugging, or reviews.';
    }
    if (classification.kind === 'complex') {
      return 'This looks like a higher-risk Claude coding task, so staying on Sonnet/Opus may avoid failed retries and wasted tokens.';
    }
    return '';
  }

  if (!['codex', 'codex-api', 'codex-chatgpt'].includes(tool) || !isCodexExec(args)) {
    return '';
  }

  const prompt = extractCodexExecPrompt(args);
  if (!prompt) return '';

  const normalized = prompt.toLowerCase();
  const simplePatterns = [
    /\bone\s+sent[ea]nce\b/,
    /\bbrief(?:ly)?\b/,
    /\bshort\b/,
    /\bsummar[yi]z?e\b/,
    /\brewrite\b/,
    /\bformat\b/,
    /\bgrammar\b/,
    /\btypo\b/,
    /\btranslate\b/,
    /\bexplain\b/,
    /\bdifference between\b/,
    /\bregex\b/,
    /\bcommit message\b/,
  ];
  const complexPatterns = [
    /\bimplement\b/,
    /\bdebug\b/,
    /\bfix\b/,
    /\brefactor\b/,
    /\barchitecture\b/,
    /\bsecurity\b/,
    /\bdeploy\b/,
    /\bmigration\b/,
    /\bproduction\b/,
    /\bmulti[-\s]?file\b/,
    /\btest suite\b/,
  ];

  const simpleScore = simplePatterns.filter(pattern => pattern.test(normalized)).length;
  const complexScore = complexPatterns.filter(pattern => pattern.test(normalized)).length;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  if (simpleScore > 0 && complexScore === 0 && wordCount <= 80) {
    return 'This looks like a simple prompt. A smaller/cheaper model may be enough; keep the stronger model for repo-wide edits, debugging, or architecture work.';
  }

  if (complexScore > 0) {
    return 'This looks like a higher-risk coding task, so staying on a stronger model may avoid failed retries and wasted tokens.';
  }

  return '';
}

function getInteractiveStartupHint(tool, args) {
  if (tool === 'claude' && args.length === 0) {
    return 'Use /model haiku for simple prompts; keep Sonnet/Opus for code edits, debugging, and reviews.';
  }

  if (!['codex', 'codex-chatgpt'].includes(tool) || !isLikelyCodexInteractiveArgs(args)) {
    return '';
  }

  return 'Use /model for mini/low on simple prompts; keep stronger models for repo-wide edits and debugging.';
}

function buildCodexPreSubmitAdvice(prompt, currentModel) {
  if (!prompt || prompt.length < 2) return null;
  if (prompt.startsWith('/')) return null;

  const model = normalizeCodexModelLabel(currentModel);
  const targetModel = process.env.TOKIMETER_ADVISOR_MODEL || 'gpt-5.4-mini low';
  if (isAlreadyOnAdvisorTarget(model, targetModel)) return null;

  const classification = classifyCodexPrompt(prompt);
  if (classification.kind !== 'simple') return null;

  return {
    prompt,
    currentModel: model || 'current model',
    targetModel,
    reason: classification.reason,
    savingsText: estimateCodexSavingsText({ prompt, currentModel: model, targetModel }),
  };
}

function buildClaudePreSubmitAdvice(prompt, currentModel) {
  if (!prompt || prompt.length < 2) return null;
  if (prompt.startsWith('/')) return null;

  const model = normalizeClaudeModelLabel(currentModel);
  // Unknown current model → stay quiet. Advising a switch to a model the user
  // may already be on is worse than missing a savings hint.
  if (!model) return null;
  const targetModel = claudeAdvisorTargetModel(model);
  if (isAlreadyOnClaudeAdvisorTarget(model, targetModel)) return null;

  const classification = classifyAdvisorPrompt(prompt);
  if (classification.kind !== 'simple') return null;

  return {
    prompt,
    currentModel: model || 'current Claude model',
    targetModel,
    reason: classification.reason,
    savingsText: estimateClaudeSavingsText({ prompt, currentModel: model, targetModel }),
  };
}

function claudeAdvisorTargetModel(currentModel = '') {
  const configured = process.env.TOKIMETER_CLAUDE_ADVISOR_MODEL || getSetting('claude.advisorModel');
  if (configured) return configured;

  const normalized = String(currentModel || '').toLowerCase();
  if (normalized.includes('haiku')) return 'haiku';
  return 'haiku';
}

function classifyCodexPrompt(prompt) {
  return classifyAdvisorPrompt(prompt);
}

function classifyAdvisorPrompt(prompt) {
  const normalized = prompt.toLowerCase();
  const simplePatterns = [
    /\bwhat\s+(day|date|time)\b/,
    /\bone\s+sent[ea]nce\b/,
    /\bbrief(?:ly)?\b/,
    /\bshort\b/,
    /\bsummar[yi]z?e\b/,
    /\brewrite\b/,
    /\bformat\b/,
    /\bgrammar\b/,
    /\btypo\b/,
    /\btranslate\b/,
    /\bexplain\b/,
    /\bdifference between\b/,
    /\bregex\b/,
    /\bcommit message\b/,
    /\bhello\b/,
    /\bhi\b/,
  ];
  const complexPatterns = [
    /\bimplement\b/,
    /\bdebug\b/,
    /\bfix\b/,
    /\brefactor\b/,
    /\barchitecture\b/,
    /\bsecurity\b/,
    /\bdeploy\b/,
    /\bmigration\b/,
    /\bproduction\b/,
    /\bmulti[-\s]?file\b/,
    /\btest suite\b/,
    /\breview\b/,
  ];

  const simpleScore = simplePatterns.filter(pattern => pattern.test(normalized)).length;
  const complexScore = complexPatterns.filter(pattern => pattern.test(normalized)).length;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  // Code blocks or long prompts are never "simple" regardless of keywords.
  if (normalized.includes('```') || wordCount > 120) {
    return { kind: 'complex', reason: '' };
  }
  if (simpleScore > 0 && complexScore === 0 && wordCount <= 80) {
    return { kind: 'simple', reason: 'simple prompt detected' };
  }
  // Short plain questions without complexity markers are simple too.
  if (complexScore === 0 && wordCount <= 25 && /\?\s*$/.test(prompt.trim())) {
    return { kind: 'simple', reason: 'short question' };
  }
  return { kind: complexScore > 0 ? 'complex' : 'unknown', reason: '' };
}

function normalizeCodexModelLabel(model) {
  return String(model || '').replace(/\s+/g, ' ').trim();
}

function isAlreadyOnAdvisorTarget(model, targetModel) {
  const normalized = String(model || '').toLowerCase();
  const target = String(targetModel || '').toLowerCase();
  return normalized === target || normalized.includes('mini') || normalized.includes('nano');
}

function normalizeClaudeModelLabel(model) {
  return String(model || '').replace(/\s+/g, ' ').trim();
}

function isAlreadyOnClaudeAdvisorTarget(model, targetModel) {
  const normalized = String(model || '').toLowerCase();
  const target = String(targetModel || '').toLowerCase();
  if (!normalized) return false;
  return normalized === target
    || normalized.includes(target)
    || (target.includes('haiku') && normalized.includes('haiku'));
}

function estimateCodexSavingsText({ prompt, currentModel, targetModel }) {
  const current = estimateCodexTurnCost(prompt, currentModel);
  const target = estimateCodexTurnCost(prompt, targetModel);
  const savings = Math.max(0, current - target);
  const percent = current > 0 ? Math.round((savings / current) * 100) : 0;

  if (savings >= 0.005) {
    return `save about $${savings.toFixed(2)} (${percent}% est.)`;
  }
  if (percent > 0) {
    return `save about ${percent}% on this turn`;
  }
  return 'reduce spend on this turn';
}

function estimateClaudeSavingsText({ prompt, currentModel, targetModel }) {
  const current = estimateClaudeTurnCost(prompt, currentModel || 'sonnet');
  const target = estimateClaudeTurnCost(prompt, targetModel);
  const savings = Math.max(0, current - target);
  const percent = current > 0 ? Math.round((savings / current) * 100) : 0;

  if (savings >= 0.005) {
    return `save about $${savings.toFixed(2)} (${percent}% est.)`;
  }
  if (percent > 0) {
    return `save about ${percent}% on this turn`;
  }
  return 'reduce spend on this turn';
}

function runAdvisorTest(testArgs) {
  const mode = testArgs[0] === 'claude' || testArgs[0] === 'codex' ? testArgs.shift() : 'codex';
  const model = testArgs[0] || (mode === 'claude' ? 'sonnet' : 'gpt-5.5 low');
  const prompt = testArgs.slice(1).join(' ') || 'hi';
  const advice = mode === 'claude'
    ? buildClaudePreSubmitAdvice(prompt, model)
    : buildCodexPreSubmitAdvice(prompt, model);
  console.log(JSON.stringify({
    mode,
    model,
    prompt,
    advised: Boolean(advice),
    advice,
  }, null, 2));
}

function estimateCodexTurnCost(prompt, model) {
  const baseModel = String(model || '').replace(/\b(low|medium|high)\b/g, '').replace(/\s+/g, ' ').trim();
  const price = getPrice(baseModel);
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const estimatedInputTokens = Math.max(1500, promptTokens * 8);
  const estimatedOutputTokens = Math.max(150, Math.ceil(promptTokens * 1.5));
  const effortMultiplier = codexEffortMultiplier(model);
  const modelMultiplier = codexModelMultiplier(model);

  if (price) {
    const inputCost = (estimatedInputTokens / 1_000_000) * price.input;
    const outputCost = (estimatedOutputTokens / 1_000_000) * price.output;
    return (inputCost + outputCost) * effortMultiplier;
  }

  const fallbackInputPer1m = 2.0;
  const fallbackOutputPer1m = 8.0;
  const inputCost = (estimatedInputTokens / 1_000_000) * fallbackInputPer1m;
  const outputCost = (estimatedOutputTokens / 1_000_000) * fallbackOutputPer1m;
  return (inputCost + outputCost) * effortMultiplier * modelMultiplier;
}

function estimateClaudeTurnCost(prompt, model) {
  const priceModel = claudePricingModel(model);
  const price = getPrice(priceModel);
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const estimatedInputTokens = Math.max(1200, promptTokens * 8);
  const estimatedOutputTokens = Math.max(120, Math.ceil(promptTokens * 1.5));

  if (price) {
    const inputCost = (estimatedInputTokens / 1_000_000) * price.input;
    const outputCost = (estimatedOutputTokens / 1_000_000) * price.output;
    return inputCost + outputCost;
  }

  const normalized = String(model || '').toLowerCase();
  const multiplier = normalized.includes('haiku') ? 0.3 : normalized.includes('opus') ? 4 : 1;
  const fallbackInputPer1m = 3.0;
  const fallbackOutputPer1m = 15.0;
  const inputCost = (estimatedInputTokens / 1_000_000) * fallbackInputPer1m;
  const outputCost = (estimatedOutputTokens / 1_000_000) * fallbackOutputPer1m;
  return (inputCost + outputCost) * multiplier;
}

function claudePricingModel(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('haiku')) return 'claude-haiku-4';
  if (normalized.includes('opus')) return 'claude-opus-4';
  if (normalized.includes('sonnet')) return 'claude-sonnet-4';
  return normalized || 'claude-sonnet-4';
}

function codexEffortMultiplier(model) {
  const normalized = String(model || '').toLowerCase();
  if (/\blow\b/.test(normalized)) return 0.35;
  if (/\bmedium\b/.test(normalized)) return 0.65;
  if (/\bhigh\b/.test(normalized)) return 1.15;
  return 1;
}

function codexModelMultiplier(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('mini')) return 0.35;
  if (normalized.includes('nano')) return 0.15;
  if (normalized.includes('pro')) return 1.4;
  return 1;
}

function extractClaudePrompt(args) {
  if (!args || args.length === 0) return '';

  const valueFlags = new Set([
    '--model',
    '--fallback-model',
    '--permission-mode',
    '--output-format',
    '--input-format',
    '--add-dir',
    '--mcp-config',
    '--settings',
    '--allowedTools',
    '--disallowedTools',
  ]);
  const promptParts = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--') {
      promptParts.push(...args.slice(args.indexOf(arg) + 1));
      break;
    }
    if (valueFlags.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;
    promptParts.push(arg);
  }

  return promptParts.join(' ').trim();
}

function extractCodexExecPrompt(args) {
  if (!isCodexExec(args)) return '';

  const valueFlags = new Set([
    '--model',
    '-m',
    '--sandbox',
    '--ask-for-approval',
    '--cd',
    '-C',
    '--config',
    '-c',
    '--output-schema',
    '--profile',
  ]);
  const promptParts = [];
  let skipNext = false;

  for (const arg of args.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--') {
      promptParts.push(...args.slice(args.indexOf(arg) + 1));
      break;
    }
    if (valueFlags.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;
    promptParts.push(arg);
  }

  return promptParts.join(' ').trim();
}

function commandPath(command, pathValue = process.env.PATH || '') {
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

async function runDoctor() {
  const cleanPath = stripShimDirFromPath(process.env.PATH || '');
  const health = await fetchJSON(`${PROXY_URL}/api/health`);
  const summary = await fetchSummary();
  const listenerPids = findListeningPids(PROXY_PORT);

  console.log(`\n  Tokimeter Doctor`);
  console.log(`  ──────────────────────────────────────────────`);
  printDoctorLine('Proxy health', health?.status === 'ok', health?.status === 'ok'
    ? `running at ${PROXY_URL}`
    : `not reachable at ${PROXY_URL}`);
  printDoctorLine('Manual tracking API', health?.manualTracking === true, health?.manualTracking === true
    ? 'available'
    : 'missing; restart the proxy with current Tokimeter');
  printDoctorLine('Proxy listener', listenerPids.length <= 1, listenerPids.length > 0
    ? `PID ${listenerPids.join(', ')}`
    : 'none');
  printDoctorLine('tokimeter command', isShimInstalled('tokimeter'), shimStatus('tokimeter'));
  printDoctorLine('tm command', isShimInstalled('tm'), shimStatus('tm'));
  printDoctorLine('Codex shim', isShimInstalled('codex'), shimStatus('codex'));
  printDoctorLine('Claude shim', isShimInstalled('claude'), shimStatus('claude'));
  printDoctorLine('Real codex', Boolean(commandPath('codex', cleanPath)), commandPath('codex', cleanPath) || 'not found outside Tokimeter shims');
  printDoctorLine('Real claude', Boolean(commandPath('claude', cleanPath)), commandPath('claude', cleanPath) || 'not found outside Tokimeter shims');
  printDoctorLine('Claude status', isClaudeStatuslineInstalled(), claudeStatuslineStatus());
  printDoctorLine('Shim PATH active', isShimPathActive(), isShimPathActive()
    ? `${SHIM_BIN_DIR} is on PATH`
    : `add ${SHIM_BIN_DIR} to PATH or restart your terminal`);
  const cloudUrl = process.env.TOKIMETER_CLOUD_URL || getSetting('cloud.url');
  const cloudKey = process.env.TOKIMETER_API_KEY || getSetting('cloud.apiKey');
  const cloudState = readCloudSyncState();
  const cloudPaused = cloudPauseActive(cloudState) || health?.cloudSyncHealth?.accessPaused === true;
  printDoctorLine('Cloud sync', true, cloudUrl && cloudKey
    ? cloudPaused
      ? `paused (${cloudState.pauseCode || health?.cloudSyncHealth?.pauseCode || 'upgrade required'}) · local tracking continues${cloudState.dataExpiresAt ? ` · cloud data expires ${String(cloudState.dataExpiresAt).slice(0, 10)}` : ''}`
      : `configured for ${cloudUrl}${health?.pendingCloudSync ? ` · ${health.pendingCloudSync} queued` : ''}${health?.cloudSyncHealth?.dropped ? ` · ${health.cloudSyncHealth.dropped} dropped at queue cap` : ''}`
    : 'off (local only) — optional, enable later with tokimeter login');
  const feed = pricingFeedStatus();
  printDoctorLine('Pricing feed', feed.exists && feed.ageDays <= 30, feed.exists
    ? `${feed.count} models, ${feed.ageDays} days old${feed.ageDays > 30 ? ' — run: tokimeter pricing refresh' : ''}`
    : 'not downloaded (built-in prices only) — run: tokimeter pricing refresh');

  for (const [label, files, kind] of [
    ['Claude log format', recentClaudeTranscriptFiles({ limit: 5 }), 'claude'],
    ['Codex log format', recentCodexRolloutFiles({ limit: 5 }), 'codex'],
  ]) {
    if (files.length === 0) {
      printDoctorLine(label, true, 'no recent local logs to sample');
      continue;
    }
    const bad = files
      .map(file => ({ file, result: analyzeLogFileFormat(file, kind) }))
      .filter(({ result }) => !result.ok);
    printDoctorLine(label, bad.length === 0, bad.length === 0
      ? `${files.length} recent file${files.length === 1 ? '' : 's'} recognized`
      : `${bad.length} of ${files.length} recent files unrecognized (${bad[0].result.reason}) — update tokimeter`);
  }

  if (existsSync(HERMES_STATE_DB)) {
    const hermesEvents = readHermesUsageEvents({ sinceMs: Date.now() - 30 * 86400 * 1000 });
    printDoctorLine('Hermes reader', hermesEvents.length > 0, hermesEvents.length > 0
      ? `${hermesEvents.length} recent session${hermesEvents.length === 1 ? '' : 's'} recognized from ${HERMES_STATE_DB}`
      : `${HERMES_STATE_DB} exists but no non-zero usage sessions were recognized`);
  }

  if (summary) {
    console.log(`  Spend summary       ${summary.todayCalls || 0} calls today / $${(summary.todayCost || 0).toFixed(4)}`);
  }
  if (!isShimPathActive()) {
    console.log('');
    console.log(`  Current terminal is not using Tokimeter shims yet.`);
    console.log(`  Run now: export PATH="${SHIM_BIN_DIR}:$PATH"`);
    console.log(`  Then check: which codex`);
    console.log(`  Expected: ${join(SHIM_BIN_DIR, 'codex')}`);
  }
  console.log(`  ──────────────────────────────────────────────\n`);
}

// Fix a stale install in one command: restart the proxy on current code,
// regenerate shims + Claude status line, refresh pricing, then re-check.
async function runRepair() {
  console.log(`\n  Tokimeter Repair`);
  console.log(`  ──────────────────────────────────────────────`);

  console.log(`  Restarting proxy on current code...`);
  await stopProxy();
  await ensureProxyRunning(false, true);

  console.log(`  Regenerating shims and Claude status line...`);
  await setupTool(['--auto']);

  console.log(`  Refreshing pricing feed...`);
  try {
    const feed = await refreshPricingFeed();
    console.log(`  ✓ Pricing feed: ${feed.count} models`);
  } catch (e) {
    console.log(`  ! Pricing feed refresh failed (offline?): ${e.message} — built-in prices still apply.`);
  }

  console.log(`  Note: restart any running codex/claude sessions so they pick up the new code.\n`);
  await runReady();
}

async function runReady() {
  const cleanPath = stripShimDirFromPath(process.env.PATH || '');
  const health = await fetchJSON(`${PROXY_URL}/api/health`);
  const proxyReady = health?.status === 'ok';
  const pathActive = isShimPathActive();
  const codexShim = isShimInstalled('codex');
  const claudeShim = isShimInstalled('claude');
  const realCodex = commandPath('codex', cleanPath);
  const realClaude = commandPath('claude', cleanPath);
  const claudeStatus = isClaudeStatuslineInstalled();
  const summary = await fetchSummary();

  const checks = [
    ['Proxy', proxyReady, proxyReady ? `running at ${PROXY_URL}` : `not running yet`],
    ['Shell PATH', pathActive, pathActive ? `${SHIM_BIN_DIR} active` : `restart terminal or export PATH="${SHIM_BIN_DIR}:$PATH"`],
    ['Codex', codexShim && Boolean(realCodex), codexShim ? (realCodex ? `normal codex routes through Tokimeter` : `real codex not found outside shims`) : `run tokimeter setup codex --auto`],
    ['Claude', claudeShim && Boolean(realClaude), claudeShim ? (realClaude ? `normal claude routes through Tokimeter` : `real claude not found outside shims`) : `run tokimeter setup claude --auto`],
    ['Claude HUD', claudeStatus, claudeStatus ? `configured` : `run tokimeter setup claude --auto`],
  ];

  const ok = checks.every(([, passed]) => passed);
  console.log(`\n  Tokimeter Ready`);
  console.log(`  ──────────────────────────────────────────────`);
  for (const [label, passed, detail] of checks) {
    printDoctorLine(label, passed, detail);
  }
  console.log(`  ──────────────────────────────────────────────`);

  if (ok) {
    console.log(`  Ready. Keep using your normal commands:`);
    console.log(`    codex`);
    console.log(`    claude`);
    if (summary) {
      console.log(`\n  Today: $${(summary.todayCost || 0).toFixed(4)} / ${summary.todayCalls || 0} calls`);
    }
    console.log(`  Diagnostic snapshot: tokimeter watch --once\n`);
    return;
  }

  console.log(`  Not fully ready yet.`);
  if (!codexShim || !claudeShim || !claudeStatus) {
    console.log(`  Run: tokimeter setup --auto`);
  }
  if (!pathActive) {
    console.log(`  Then restart your terminal, or run now: export PATH="${SHIM_BIN_DIR}:$PATH"`);
  }
  if (!proxyReady) {
    console.log(`  Proxy will auto-start during setup or normal CLI use.`);
  }
  console.log(`  Detailed diagnostics: tokimeter doctor\n`);
}

async function runPricingCommand(pricingArgs) {
  const command = pricingArgs[0] || 'list';

  if (command === 'refresh') {
    try {
      const result = await refreshPricingFeed();
      console.log(`  ✓ Pricing feed refreshed: ${result.count} models cached at ${result.file}`);
      console.log(`  Precedence: your custom prices > Tokimeter verified built-ins > community feed.`);
    } catch (e) {
      console.error(`  ❌ Pricing feed refresh failed: ${e.message}`);
      console.error(`  Built-in and custom pricing still work offline.`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'status') {
    const status = pricingFeedStatus();
    if (!status.exists) {
      console.log(`  Pricing feed: not downloaded. Run: tokimeter pricing refresh`);
    } else {
      console.log(`  Pricing feed: ${status.count} models · fetched ${status.fetchedAt} (${status.ageDays} days ago)`);
      if (status.ageDays > 30) console.log(`  ⚠ Feed is over 30 days old — run: tokimeter pricing refresh`);
    }
    return;
  }

  if (command === 'list') {
    const provider = pricingArgs.find(arg => arg.startsWith('--provider='))?.split('=')[1] || '';
    const models = listModels(provider).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    console.log(`\n  Tokimeter Pricing${provider ? ` · ${provider}` : ''}`);
    console.log(`  ──────────────────────────────────────────────`);
    for (const model of models) {
      const marker = model.custom ? 'custom' : (model.feed ? 'community-feed' : 'verified-built-in');
      console.log(`  ${model.provider.padEnd(10)} ${model.model.padEnd(32)} in $${model.input}/1M · out $${model.output}/1M · cached $${model.cached}/1M · ${marker}`);
    }
    console.log(`\n  Custom pricing file: ${getPricingSource('__missing__').file}`);
    console.log(`  Add/update: tokimeter pricing add --provider anthropic --model claude-haiku-4 --input 0.80 --output 4.00 --cached 0.08\n`);
    return;
  }

  if (command === 'source') {
    const model = pricingArgs.slice(1).join(' ').trim();
    if (!model) {
      console.error(`  Usage: tokimeter pricing source <model>`);
      process.exitCode = 1;
      return;
    }
    const source = getPricingSource(model);
    if (source.confidence === 'fallback') {
      console.log(`  ${model}: unpriced. A rough $2/$8-per-1M fallback is shown separately and excluded from priced totals.`);
      console.log(`  Add custom pricing to include this model in priced totals.`);
    } else {
      console.log(`  ${model}: ${source.confidence} pricing via ${source.source}${source.model ? ` (${source.model})` : ''}`);
    }
    return;
  }

  if (command === 'add') {
    const values = parseKeyValueArgs(pricingArgs.slice(1));
    const required = ['provider', 'model', 'input', 'output'];
    const missing = required.filter(key => !values[key]);
    if (missing.length > 0) {
      console.error(`  Missing required pricing fields: ${missing.join(', ')}`);
      console.error(`  Usage: tokimeter pricing add --provider anthropic --model claude-haiku-4 --input 0.80 --output 4.00 --cached 0.08`);
      process.exitCode = 1;
      return;
    }
    const aliases = values.aliases ? values.aliases.split(',').map(value => value.trim()).filter(Boolean) : [];
    const price = addCustomPrice({
      provider: values.provider,
      model: values.model,
      input: values.input,
      output: values.output,
      cached: values.cached || 0,
      aliases,
    });
    console.log(`  ✓ Custom price saved: ${price.provider}/${price.model} in $${price.input}/1M · out $${price.output}/1M`);
    console.log(`    File: ${getPricingSource(price.model).file}`);
    console.log(`    Restart Tokimeter proxy to apply this price to new API traffic.`);
    return;
  }

  console.error(`  Unknown pricing command: ${command}`);
  console.error(`  Use: tokimeter pricing list, tokimeter pricing source <model>, or tokimeter pricing add ...`);
  process.exitCode = 1;
}

function cloudEventsUrl(baseUrl) {
  const base = new URL(baseUrl);
  if (base.pathname.includes('/functions/')) return base;
  if (base.pathname.endsWith('/v1/events')) return base;
  return new URL('/v1/events', base);
}

async function fetchCloudJson(url, { body, apiKey = '', timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const result = cloudResponseResult(response.status, data);
      const error = new Error(String(result.error || `request failed (${response.status})`));
      Object.assign(error, result);
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function readCloudSyncState() {
  try {
    return JSON.parse(readFileSync(CLOUD_SYNC_STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCloudSyncState(state) {
  ensureDataDir();
  writeFileSync(CLOUD_SYNC_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  try { chmodSync(CLOUD_SYNC_STATE_FILE, 0o600); } catch {}
}

function cloudProjectMode(syncArgs = []) {
  const arg = syncArgs.find((item) => item.startsWith('--project='));
  const mode = String(arg?.split('=')[1] || getSetting('cloud.projectMode') || 'basename').toLowerCase();
  return ['basename', 'full', 'off'].includes(mode) ? mode : 'basename';
}

async function runCloudSync(syncArgs = [], { afterConnect = false } = {}) {
  const quiet = syncArgs.includes('--quiet');
  const daysArg = syncArgs.find((item) => item.startsWith('--days='));
  const explicitDays = daysArg ? Math.max(1, Math.min(3650, parseInt(daysArg.split('=')[1], 10) || 30)) : null;
  const cloudUrl = String(process.env.TOKIMETER_CLOUD_URL || getSetting('cloud.url') || '').replace(/\/$/, '');
  const cloudKey = String(process.env.TOKIMETER_API_KEY || getSetting('cloud.apiKey') || '');
  if (!cloudUrl || !cloudKey) {
    if (!quiet) console.error('  Cloud sync is not connected. Open tokimeter.com/app and run its `tokimeter connect ...` command.');
    process.exitCode = quiet ? 0 : 1;
    return { ok: false, sent: 0 };
  }

  const state = readCloudSyncState();
  const now = Date.now();
  // Background scans do not repeatedly invoke the hosted function after an
  // expired trial. Manual `tokimeter sync` deliberately probes immediately so
  // an upgrade can reactivate existing credentials without reconnecting.
  if (quiet && cloudPauseActive(state, now)) {
    return { ok: false, sent: 0, paused: true };
  }
  const lastSuccess = Number(state.lastSuccessAt) || 0;
  const maxAgeMs = explicitDays
    ? explicitDays * 86400 * 1000
    : lastSuccess
      ? Math.max(10 * 60 * 1000, now - lastSuccess + 5 * 60 * 1000)
      : 2 * 86400 * 1000;
  const projectMode = cloudProjectMode(syncArgs);
  const events = collectLocalUsageEvents({ maxAgeMs });
  // Replays prioritize current activity. If a large backfill is interrupted,
  // the dashboard still catches up from newest to oldest on the next scan.
  const payloads = newestFirstCloudEvents(events)
    .map((event) => eventToCloudPayload(event, { projectMode }));
  const batches = chunkCloudEvents(payloads, 200);
  let sent = 0;
  try {
    for (const batch of batches) {
      const result = await sendCloudBatchWithRetry(() => fetchCloudJson(cloudEventsUrl(cloudUrl), {
        apiKey: cloudKey,
        body: { contract_version: 1, events: batch },
        timeoutMs: 30000,
      }), {
        // Interactive sync/connect can finish a large backfill across quota
        // windows. Background scans return promptly and resume newest-first.
        maxQuotaRetries: quiet ? 0 : 10,
        onQuotaWait: quiet ? null : (waitMs) => {
          console.log(`  Cloud ingest is catching up; resuming in ${Math.ceil(waitMs / 1000)}s…`);
        },
      });
      sent += Number(result.accepted ?? batch.length);
    }
    writeCloudSyncState({ ...clearCloudPause(state), lastSuccessAt: now, projectMode });
    if (!quiet) {
      const scope = explicitDays ? `last ${explicitDays} days` : 'new local activity';
      console.log(`  ✓ Synced ${sent} metadata-only events (${scope})`);
      console.log(`    Projects: ${projectMode === 'basename' ? 'folder names only' : projectMode === 'off' ? 'not synced' : 'full paths (explicit opt-in)'}`);
      if (afterConnect && events.length === 0) console.log('    No local usage was found yet. New activity will sync automatically.');
    }
    return { ok: true, sent };
  } catch (error) {
    if (error?.terminalFailure) {
      const paused = cloudPauseState(state, error, now);
      writeCloudSyncState(paused);
      if (!quiet) {
        console.error(`  ⚠️ ${paused.pauseMessage}`);
        if (paused.dataExpiresAt) console.error(`    Retained cloud data expires ${new Date(paused.dataExpiresAt).toLocaleDateString()}.`);
        if (paused.pauseCode === 'device_key_invalid') {
          console.error(`    Reconnect this device from ${paused.upgradeUrl || 'https://tokimeter.com/app/'}.`);
        } else {
          console.error(`    Upgrade: ${paused.upgradeUrl || 'https://tokimeter.com/app/'}`);
          console.error('    After upgrading, run `tokimeter sync` to resume immediately.');
        }
        console.error('    Local tracking continues.');
      }
    } else if (!quiet) {
      console.error(`  ⚠️ Cloud sync did not finish: ${error.message}`);
    }
    process.exitCode = quiet ? 0 : 1;
    return { ok: false, sent, paused: Boolean(error?.terminalFailure) };
  }
}

async function runConnect(connectArgs) {
  const code = connectArgs.find((arg) => !arg.startsWith('-')) || '';
  const urlArg = connectArgs.find((arg) => arg.startsWith('--url='));
  const connectUrl = String(urlArg?.slice('--url='.length) || DEFAULT_CONNECT_URL);
  if (!/^tmc_[A-Za-z0-9_-]{24,}$/.test(code)) {
    console.error('  Usage: tokimeter connect <one-time-code>');
    console.error('  Get the command from tokimeter.com/app after signing in.');
    process.exitCode = 1;
    return;
  }

  console.log('  Connecting this Tokimeter installation...');
  let result;
  try {
    result = await fetchCloudJson(connectUrl, { body: { action: 'exchange', code } });
  } catch (error) {
    console.error(`  ❌ Connection failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!result?.api_key || !result?.ingest_url) {
    console.error('  ❌ Connection service returned an incomplete response.');
    process.exitCode = 1;
    return;
  }

  setSetting('cloud.url', result.ingest_url);
  setSetting('cloud.apiKey', result.api_key);
  setSetting('cloud.connectUrl', connectUrl);
  if (!getSetting('cloud.projectMode')) setSetting('cloud.projectMode', 'basename');
  console.log(`  ✓ Connected${result.device?.name ? ` as ${result.device.name}` : ''}`);
  console.log('    Only usage metadata syncs. Prompts, responses, code, account identity, and full paths are excluded.');

  // A reconnect continues from the last successful local cursor. A genuinely
  // new installation still receives the documented 30-day first backfill.
  const priorSync = readCloudSyncState();
  await runCloudSync(Number(priorSync.lastSuccessAt) > 0 ? [] : ['--days=30'], { afterConnect: true });
  if (!connectArgs.includes('--no-restart')) {
    await stopProxy();
    await sleep(300);
    const ready = await ensureProxyRunning(false, true);
    if (ready) console.log('  ✓ Automatic background sync is active');
  }
}

// Advanced/manual connection path. Normal customers use `tokimeter connect`
// with the one-time command shown by the signed-in dashboard.
async function runLogin(loginArgs) {
  const url = (loginArgs.find(arg => !arg.startsWith('--')) || process.env.TOKIMETER_CLOUD_URL || '').replace(/\/$/, '');
  const key = loginArgs.filter(arg => !arg.startsWith('--'))[1] || process.env.TOKIMETER_API_KEY || '';

  if (!url || !key) {
    console.error(`  Usage: tokimeter login <cloud-url> <api-key>`);
    console.error(`  Example: tokimeter login https://cloud.tokimeter.com tk_xxxxx`);
    console.error(`  Stores cloud.url and cloud.apiKey in ${SETTINGS_FILE}.`);
    console.error(`  Normal setup: open tokimeter.com/app and run its one-time connect command.`);
    process.exitCode = 1;
    return;
  }
  if (!/^https?:\/\//.test(url)) {
    console.error(`  Cloud URL must start with http:// or https:// (got: ${url})`);
    process.exitCode = 1;
    return;
  }

  setSetting('cloud.url', url);
  setSetting('cloud.apiKey', key);
  if (!getSetting('cloud.projectMode')) setSetting('cloud.projectMode', 'basename');
  console.log(`  ✓ Signed in to ${url}`);
  console.log(`  Only usage metadata will sync (tokens, models, costs, and project folder names by default).`);
  console.log(`  Prompts and code never leave this machine — the schema has no field for them.`);
  console.log(`  Restart the proxy to start syncing: tokimeter repair`);
  console.log(`  Undo anytime: tokimeter logout`);
}

function runLogout() {
  const settings = readSettings();
  const wasConfigured = Boolean(settings?.cloud?.url || settings?.cloud?.apiKey);
  if (settings && typeof settings === 'object') {
    delete settings.cloud;
    writeSettings(settings);
  }
  try { unlinkSync(CLOUD_SYNC_STATE_FILE); } catch {}
  console.log(wasConfigured
    ? `  ✓ Signed out — cloud sync disabled and API key removed from ${SETTINGS_FILE}.`
    : `  Already signed out — no cloud settings were stored.`);
  console.log(`  Restart the proxy to apply: tokimeter repair`);
}

function runConfigCommand(configArgs) {
  const command = configArgs[0] || 'list';
  if (command === 'list') {
    const settings = readSettings();
    console.log(`\n  Tokimeter Config`);
    console.log(`  ──────────────────────────────────────────────`);
    const entries = flattenObject(settings);
    if (Object.keys(entries).length === 0) {
      console.log(`  No local settings yet.`);
    } else {
      for (const [key, value] of Object.entries(entries).sort()) {
        const display = /(?:apiKey|secret|token)$/i.test(key)
          ? `${String(value).slice(0, 8)}…${String(value).slice(-4)} (hidden)`
          : value;
        console.log(`  ${key.padEnd(28)} ${display}`);
      }
    }
    console.log(`\n  File: ${SETTINGS_FILE}`);
    console.log(`  Example: tokimeter config set claude.advisorModel haiku\n`);
    return;
  }

  if (command === 'get') {
    const key = configArgs[1];
    if (!key) {
      console.error(`  Usage: tokimeter config get <key>`);
      process.exitCode = 1;
      return;
    }
    console.log(getSetting(key) ?? '');
    return;
  }

  if (command === 'set') {
    const key = configArgs[1];
    const value = configArgs.slice(2).join(' ').trim();
    if (!key || !value) {
      console.error(`  Usage: tokimeter config set <key> <value>`);
      console.error(`  Example: tokimeter config set claude.advisorModel haiku`);
      process.exitCode = 1;
      return;
    }
    setSetting(key, value);
    console.log(`  ✓ ${key} = ${value}`);
    return;
  }

  console.error(`  Unknown config command: ${command}`);
  console.error(`  Use: tokimeter config list, tokimeter config get <key>, or tokimeter config set <key> <value>`);
  process.exitCode = 1;
}

function readSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  ensureDataDir();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  try { chmodSync(SETTINGS_FILE, 0o600); } catch {}
}

function getSetting(path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = readSettings();
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return '';
    current = current[part];
  }
  return current;
}

function setSetting(path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  const settings = readSettings();
  let current = settings;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  writeSettings(settings);
}

function flattenObject(value, prefix = '') {
  const out = {};
  for (const [key, child] of Object.entries(value || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(out, flattenObject(child, nextKey));
    } else {
      out[nextKey] = child;
    }
  }
  return out;
}

function parseKeyValueArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    if (arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      values[key] = rest.join('=');
      continue;
    }
    values[arg.slice(2)] = args[i + 1];
    i += 1;
  }
  return values;
}

function runPostinstall() {
  console.log(`Tokimeter ${readProxyPackageVersion()} installed.`);
  console.log(`Run "tokimeter setup --auto" to configure local Codex and Claude shims.`);
}

function readProxyPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PROXY_PACKAGE_JSON, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printDoctorLine(label, ok, detail) {
  const mark = ok ? '✓' : '!';
  console.log(`  ${mark} ${label.padEnd(18)} ${detail}`);
}

function isShimInstalled(command) {
  return existsSync(join(SHIM_BIN_DIR, command));
}

function shimStatus(command) {
  const shimPath = join(SHIM_BIN_DIR, command);
  if (!existsSync(shimPath)) return `not installed; run tokimeter setup --auto`;
  return shimPath;
}

function isShimPathActive() {
  return (process.env.PATH || '').split(':').includes(SHIM_BIN_DIR);
}

function uninstallAutoSetup() {
  let removed = 0;
  const codexRestore = uninstallCodexProfiles();
  if (codexRestore.detail) {
    console.log(`  ${codexRestore.changed ? '✓' : '⚠️'} ${codexRestore.detail}`);
  }
  const claudeRestore = uninstallClaudeStatusline();
  if (claudeRestore.changed) {
    console.log(`  ✓ ${claudeRestore.detail}`);
  } else if (claudeRestore.detail) {
    console.log(`  ${claudeRestore.detail}`);
  }

  if (existsSync(GROK_HOOK_FILE)) {
    try {
      unlinkSync(GROK_HOOK_FILE);
      console.log(`  ✓ Removed Grok budget-pulse hook: ${GROK_HOOK_FILE}`);
    } catch {
      console.log(`  ⚠️ Could not remove ${GROK_HOOK_FILE}`);
    }
  }

  const cursorRestore = uninstallCursorInline();
  if (cursorRestore.changed) {
    console.log(`  ✓ ${cursorRestore.detail}`);
  } else if (cursorRestore.detail) {
    console.log(`  ${cursorRestore.detail}`);
  }

  for (const command of ['codex', 'claude', 'tokimeter', 'tm']) {
    const shimPath = join(SHIM_BIN_DIR, command);
    if (!existsSync(shimPath)) continue;
    try {
      unlinkSync(shimPath);
      console.log(`  ✓ Removed shim: ${shimPath}`);
      removed++;
    } catch {
      console.log(`  ⚠️ Could not remove shim: ${shimPath}`);
    }
  }

  const rcFiles = [
    join(homedir(), '.zshrc'),
    join(homedir(), '.bashrc'),
    join(homedir(), '.bash_profile'),
  ];
  for (const rcFile of rcFiles) {
    if (!existsSync(rcFile)) continue;
    const original = readFileSync(rcFile, 'utf8');
    const next = removeMarkedPathBlock(original);
    if (next !== original) {
      writeFileSync(rcFile, next);
      console.log(`  ✓ Removed Tokimeter PATH block from ${rcFile}`);
    }
  }

  if (removed === 0) {
    console.log(`  No Tokimeter shims found in ${SHIM_BIN_DIR}.`);
  }
  console.log(`  Restart your terminal to refresh PATH.`);
}

// Reverse `tokimeter setup cursor`: restore any backed-up statusLine and pull
// our capture hook out of hooks.json, leaving everything else untouched.
function uninstallCursorInline() {
  let changed = false;
  const details = [];
  try {
    if (existsSync(CURSOR_CLI_CONFIG)) {
      const config = JSON.parse(readFileSync(CURSOR_CLI_CONFIG, 'utf8')) || {};
      const value = config.statusLine;
      if (value && typeof value.command === 'string' && value.command.includes(CURSOR_STATUSLINE_SCRIPT)) {
        let prev = null;
        if (existsSync(CURSOR_STATUSLINE_PREV)) {
          try { prev = JSON.parse(readFileSync(CURSOR_STATUSLINE_PREV, 'utf8')).statusLine || null; } catch {}
        }
        if (prev) config.statusLine = prev;
        else delete config.statusLine;
        writeFileSync(CURSOR_CLI_CONFIG, JSON.stringify(config, null, 2) + '\n');
        changed = true;
        details.push(`Cursor status line ${prev ? 'restored' : 'removed'} in ${CURSOR_CLI_CONFIG}`);
      }
    }
    if (existsSync(CURSOR_HOOKS_FILE)) {
      const hooksFile = JSON.parse(readFileSync(CURSOR_HOOKS_FILE, 'utf8')) || {};
      let hooksChanged = false;
      for (const event of ['stop', 'subagentStop']) {
        const list = hooksFile.hooks && Array.isArray(hooksFile.hooks[event]) ? hooksFile.hooks[event] : null;
        if (!list) continue;
        const next = list.filter((h) => !(h && typeof h.command === 'string' && h.command.includes('cursor-capture')));
        if (next.length !== list.length) {
          if (next.length) hooksFile.hooks[event] = next;
          else delete hooksFile.hooks[event];
          hooksChanged = true;
        }
      }
      if (hooksChanged) {
        writeFileSync(CURSOR_HOOKS_FILE, JSON.stringify(hooksFile, null, 2) + '\n');
        changed = true;
        details.push(`Cursor usage hook removed from ${CURSOR_HOOKS_FILE}`);
      }
    }
    for (const file of [CURSOR_STATUSLINE_SCRIPT, CURSOR_STATUSLINE_PREV]) {
      if (!existsSync(file)) continue;
      unlinkSync(file);
      changed = true;
    }
    return { changed, detail: details.join('; ') || (changed ? 'Removed generated Cursor status-line files' : '') };
  } catch (err) {
    return { changed, detail: `⚠️ Cursor cleanup incomplete: ${err.message}` };
  }
}

function uninstallClaudeStatusline() {
  try {
    const settings = readClaudeSettings();
    if (!settings.ok) return { changed: false, detail: `⚠️ ${settings.detail}` };
    let changed = false;

    if (isTokimeterClaudeStatusline(settings.value.statusLine)) {
      const saved = existsSync(CLAUDE_STATUSLINE_PREV)
        ? JSON.parse(readFileSync(CLAUDE_STATUSLINE_PREV, 'utf8'))
        : {};
      if (existsSync(CLAUDE_STATUSLINE_PREV)) {
        const prev = saved.statusLine;
        if (prev) {
          settings.value.statusLine = prev;
        } else {
          delete settings.value.statusLine;
        }
      } else {
        delete settings.value.statusLine;
      }
      mkdirSync(CLAUDE_HOME, { recursive: true });
      changed = true;
    }

    if (isTokimeterClaudeSpinner(settings.value.spinnerVerbs)) {
      const saved = existsSync(CLAUDE_STATUSLINE_PREV)
        ? JSON.parse(readFileSync(CLAUDE_STATUSLINE_PREV, 'utf8'))
        : {};
      if (saved.spinnerVerbs) {
        settings.value.spinnerVerbs = saved.spinnerVerbs;
      } else {
        delete settings.value.spinnerVerbs;
      }
      changed = true;
    }

    if (changed) {
      mkdirSync(CLAUDE_HOME, { recursive: true });
      writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings.value, null, 2) + '\n');
    }

    for (const file of [CLAUDE_STATUSLINE_SCRIPT, CLAUDE_STATUSLINE_PREV]) {
      if (!existsSync(file)) continue;
      unlinkSync(file);
      changed = true;
    }

    return {
      changed,
      detail: changed ? 'Restored Claude status line' : '',
    };
  } catch (err) {
    return { changed: false, detail: `⚠️ Could not restore Claude status line: ${err.message}` };
  }
}

function removeMarkedPathBlock(text) {
  const pattern = new RegExp(`\\n?${escapeRegExp(AUTO_PATH_START)}[\\s\\S]*?${escapeRegExp(AUTO_PATH_END)}\\n?`, 'g');
  return text.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ensureCodexProfiles() {
  if (!existsSync(CODEX_HOME)) {
    mkdirSync(CODEX_HOME, { recursive: true });
  }
  ensureDataDir();

  if (!existsSync(CODEX_PROFILES_PREV)) {
    const previous = {};
    for (const file of [CODEX_API_PROFILE, CODEX_CHATGPT_PROFILE]) {
      previous[file] = existsSync(file)
        ? { existed: true, content: readFileSync(file, 'utf8') }
        : { existed: false };
    }
    writeFileSync(CODEX_PROFILES_PREV, JSON.stringify(previous, null, 2) + '\n');
    try { chmodSync(CODEX_PROFILES_PREV, 0o600); } catch {}
  }

  const apiProfile = `# Generated by Tokimeter.
# API-key mode. Use with: codex --profile tokimeter "your task"

model_provider = "tokimeter"

[model_providers.tokimeter]
name = "Tokimeter local proxy"
base_url = "${PROXY_URL}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;

  const chatgptProfile = `# Generated by Tokimeter.
# ChatGPT/Codex subscription mode does not proxy ChatGPT auth traffic.
#
# Use:
#   tm codex-chatgpt "your task"
#
# The wrapper runs Codex with your existing Codex/ChatGPT login and records
# the token summary Codex prints at the end of the run.
`;

  writeFileSync(CODEX_API_PROFILE, apiProfile);
  writeFileSync(CODEX_CHATGPT_PROFILE, chatgptProfile);
}

function uninstallCodexProfiles() {
  try {
    let changed = false;
    if (existsSync(CODEX_PROFILES_PREV)) {
      const previous = JSON.parse(readFileSync(CODEX_PROFILES_PREV, 'utf8')) || {};
      for (const file of [CODEX_API_PROFILE, CODEX_CHATGPT_PROFILE]) {
        const saved = previous[file];
        if (saved?.existed) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, String(saved.content || ''));
          changed = true;
        } else if (existsSync(file) && readFileSync(file, 'utf8').startsWith('# Generated by Tokimeter.')) {
          unlinkSync(file);
          changed = true;
        }
      }
      unlinkSync(CODEX_PROFILES_PREV);
      changed = true;
      return { changed, detail: 'Restored prior Codex profiles' };
    }

    for (const file of [CODEX_API_PROFILE, CODEX_CHATGPT_PROFILE]) {
      if (!existsSync(file)) continue;
      if (!readFileSync(file, 'utf8').startsWith('# Generated by Tokimeter.')) continue;
      unlinkSync(file);
      changed = true;
    }
    return { changed, detail: changed ? 'Removed generated Codex profiles' : '' };
  } catch (err) {
    return { changed: false, detail: `Could not restore Codex profiles: ${err.message}` };
  }
}

async function trackCodexSummary(text, meta) {
  const usage = parseCodexUsage(text);
  if (!usage || usage.totalTokens <= 0) return false;

  const payload = {
    timestamp: meta.startedAt,
    provider: 'openai',
    model: usage.model || 'codex-chatgpt',
    inputTokens: usage.inputTokens || usage.totalTokens,
    outputTokens: usage.outputTokens || 0,
    cachedTokens: usage.cachedTokens || 0,
    latencyMs: meta.latencyMs,
    success: meta.success,
    tool: 'codex',
    source: 'codex-cli-summary',
    confidence: 'estimated',
    pricingConfidence: getPricingSource(usage.model || 'codex-chatgpt').confidence,
    note: usage.estimated
      ? 'Estimated from Codex CLI total token summary; subscription mode does not expose exact billing buckets.'
      : 'Parsed from Codex CLI usage summary.',
  };

  const result = await postJSON(`${PROXY_URL}/api/track`, payload);
  return Boolean(result?.ok);
}

function parseCodexUsage(text) {
  const fromJson = parseCodexJsonUsage(text);
  const fromText = parseCodexTextUsage(text);

  if (fromJson && fromJson.totalTokens > 0) {
    return {
      ...fromJson,
      model: fromJson.model || fromText?.model || '',
    };
  }

  return fromText;
}

function parseCodexJsonUsage(text) {
  let best = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const data = JSON.parse(trimmed);
      const usage = findUsage(data);
      if (!usage) continue;
      if (!best || usage.totalTokens >= best.totalTokens) {
        best = usage;
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }
  return best;
}

function findUsage(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  const usage = value.usage && typeof value.usage === 'object' ? value.usage : value;
  const inputTokens = numberFromAny(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberFromAny(usage.output_tokens ?? usage.completion_tokens);
  const cachedTokens = numberFromAny(
    usage.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens
  );
  const totalTokens = numberFromAny(usage.total_tokens ?? usage.totalTokens);

  if (inputTokens || outputTokens || totalTokens) {
    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: totalTokens || inputTokens + outputTokens + cachedTokens,
      model: findModel(value) || '',
      estimated: false,
    };
  }

  let best = null;
  for (const child of Object.values(value)) {
    const next = findUsage(child, seen);
    if (next && (!best || next.totalTokens > best.totalTokens)) {
      best = next;
    }
  }
  return best;
}

function findModel(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (typeof value.model === 'string' && value.model) return value.model;
  for (const child of Object.values(value)) {
    const found = findModel(child, seen);
    if (found) return found;
  }
  return '';
}

function parseCodexTextUsage(text) {
  const modelMatch = text.match(/^\s*model:\s*([^\r\n]+)/im);
  const directMatch = text.match(/tokens\s+used\s*:?\s*([0-9][0-9,._]*)/i);
  let totalTokens = directMatch ? numberFromAny(directMatch[1]) : 0;

  if (!totalTokens) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/tokens\s+used/i.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        totalTokens = numberFromAny(lines[j]);
        if (totalTokens) break;
      }
      if (totalTokens) break;
    }
  }

  if (!totalTokens) return null;
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens,
    model: modelMatch ? modelMatch[1].trim() : '',
    estimated: true,
  };
}

function numberFromAny(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[,_\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return 0;
  return Number(cleaned);
}

function appendCaptured(current, chunk) {
  const next = current + chunk.toString();
  return next.length > 2_000_000 ? next.slice(-2_000_000) : next;
}

function postJSON(url, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      timeout: 2000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          resolve({ ok: true });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function showStatus() {
  const healthy = await checkProxyHealth();
  if (healthy) {
    const summary = await fetchSummary();
    console.log(`\n  ✓ Tokimeter Proxy: ${healthy ? 'RUNNING' : 'OFFLINE'}`);
    console.log(`    URL: ${PROXY_URL}`);
    console.log(`    Today: $${(summary?.todayCost || 0).toFixed(2)} (${summary?.todayCalls || 0} calls)`);
    console.log(`    Total: $${(summary?.totalCost || 0).toFixed(2)} (${summary?.totalCalls || 0} calls)`);
    if ((summary?.roughEstimateCost || 0) > 0) {
      console.log(`    Unknown models: rough ~$${summary.roughEstimateCost.toFixed(2)} excluded (${summary.roughEstimateCalls || 0} calls)`);
    }
    console.log('');
  } else {
    console.log(`\n  ❌ Proxy: OFFLINE`);
    console.log(`    Start it with: tm start\n`);
  }
}

async function runWatch(watchArgs) {
  const once = watchArgs.includes('--once');
  const live = watchArgs.includes('--live');
  const debug = watchArgs.includes('--debug');
  const intervalArg = watchArgs.find(arg => arg.startsWith('--interval='));
  const intervalSeconds = Math.max(1, parseInt(intervalArg?.split('=')[1] || '5', 10) || 5);
  const toolFilter = parseToolFilter(watchArgs);

  if (!(await ensureProxyRunning(false, true))) {
    process.exit(1);
  }

  console.log(`\n  Tokimeter Watch${toolFilter ? ` · ${toolFilter} only` : ''}`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Proxy: ${PROXY_URL}`);
  if (toolFilter) {
    console.log(`  Tool filter: ${toolFilter} (totals computed from the most recent 500 tracked calls).`);
  }
  console.log(`  No extra model calls are made by this view.`);
  if (!once && !live && !debug) {
    console.log(`  Quiet mode: prints only when usage changes. Use --live for polling output.`);
  }
  console.log(`  Press Ctrl+C to stop.\n`);

  let lastCallId = '';
  let lastSnapshotKey = '';
  const render = async ({ force = false } = {}) => {
    const codexImported = (!toolFilter || toolFilter === 'codex')
      ? await importCodexRolloutTokenCounts({ verbose: debug })
      : 0;
    const claudeImported = (!toolFilter || toolFilter === 'claude')
      ? await importClaudeTranscriptUsage({ verbose: debug })
      : 0;
    if (!toolFilter || toolFilter === 'grok') await importGrokUsage([], { quiet: !debug });
    if (!toolFilter || toolFilter === 'hermes') await importHermesUsage([], { quiet: !debug });
    const summary = await fetchSummary();
    const tips = toolFilter ? [] : await fetchTips();
    const allCalls = await fetchRecentCalls(500);
    const calls = toolFilter
      ? (Array.isArray(allCalls) ? allCalls.filter(call => callMatchesTool(call, toolFilter)) : [])
      : allCalls;
    const callsSummary = summarizeCalls(calls);
    const scoped = toolFilter ? callsSummary : null;
    const todayCost = scoped ? scoped.todayCost : (summary?.todayCost || 0);
    const todayCalls = scoped ? scoped.todayCalls : (summary?.todayCalls || 0);
    const totalCost = scoped ? scoped.totalCost : (summary?.totalCost || 0);
    const totalCalls = scoped ? scoped.totalCalls : (summary?.totalCalls || 0);
    const totalRoughEstimateCost = scoped ? scoped.roughEstimateCost : (summary?.roughEstimateCost || 0);
    const todayEstCost = Math.min(todayCost, callsSummary.todayEstCost);
    const latest = Array.isArray(calls) && calls.length > 0 ? calls[0] : null;
    const tip = toolFilter
      ? `Showing ${toolFilter} usage only; run tokimeter watch for global tips and totals.`
      : (tips.length > 0 ? tips[Math.floor(Date.now() / 5000) % tips.length] : 'Tokimeter is waiting for LLM calls.');
    const latestId = latest ? `${latest.timestamp}-${latest.tool}-${latest.model}-${latest.totalCost}` : '';
    const breakdown = formatTodayModelBreakdown(calls, todayCalls);
    const sessionBreakdown = formatTodaySessionBreakdown(calls);
    const snapshotKey = [
      todayCost,
      todayCalls,
      totalCost,
      totalCalls,
      totalRoughEstimateCost,
      latestId,
      breakdown,
      sessionBreakdown,
    ].join('|');

    if (!force && !once && !live && !debug && snapshotKey === lastSnapshotKey) {
      return false;
    }
    lastSnapshotKey = snapshotKey;

    const scopeLabel = toolFilter ? ` [${toolFilter}]` : '';
    const totalLabel = toolFilter ? 'Recent total' : 'Total';
    const totalText = scoped ? formatCostWithBasis(totalCost, scoped.totalEstCost) : `$${totalCost.toFixed(4)}`;
    const roughText = totalRoughEstimateCost > 0 ? ` · unknown rough ~$${totalRoughEstimateCost.toFixed(4)} excluded` : '';
    console.log(`  ${new Date().toLocaleTimeString()}${scopeLabel}  Today ${formatCostWithBasis(todayCost, todayEstCost)} / ${todayCalls} calls · ${totalLabel} ${totalText} / ${totalCalls} calls${roughText}`);
    console.log(`  Tip: ${tip}`);
    if (debug) {
      console.log(`  Import: ${codexImported} new Codex metadata events, ${claudeImported} new Claude transcript events`);
    }

    if (latest) {
      if (latestId !== lastCallId) {
        lastCallId = latestId;
        const effort = latest.effort ? ` ${latest.effort}` : '';
        const reasoning = latest.reasoningTokens ? ` / ${latest.reasoningTokens} reasoning` : '';
        const context = formatCallContext(latest);
        const labels = formatCallLabels(latest);
        console.log(`  Latest: ${latest.tool || 'llm'}${context ? ` · ${context}` : ''} · ${latest.model || 'unknown'}${effort} · ${labels} · ${latest.inputTokens || 0} in / ${latest.outputTokens || 0} out${reasoning} · ${formatCallCost(latest)}`);
      }
    } else if (toolFilter) {
      console.log(`  No ${toolFilter} usage found in the most recent 500 tracked calls.`);
    }
    if (breakdown) console.log(`  Models: ${breakdown}`);
    if (sessionBreakdown) console.log(`  Sessions: ${sessionBreakdown}`);
    console.log('');
    return true;
  };

  await render({ force: true });
  if (once) return;

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.log('  Watch stopped.');
    process.exit(0);
  });

  while (!stopped) {
    await sleep(intervalSeconds * 1000);
    if (!stopped) await render();
  }
}

async function runLatest(latestArgs) {
  const toolFilter = parseToolFilter(latestArgs);

  // Cursor capture is a standalone local JSONL written by Cursor's hook. A
  // cursor-only latest view should work even when the proxy is stopped.
  if (toolFilter !== 'cursor' && !(await ensureProxyRunning(false, true))) {
    process.exit(1);
  }

  if (!toolFilter || toolFilter === 'codex') await importCodexRolloutTokenCounts({});
  if (!toolFilter || toolFilter === 'claude') await importClaudeTranscriptUsage({});
  if (!toolFilter || toolFilter === 'grok') await importGrokUsage([], { quiet: true });
  if (!toolFilter || toolFilter === 'hermes') await importHermesUsage([], { quiet: true });

  const serverCalls = await fetchRecentCalls(500);
  // Cursor's exact stop-hook records live in their own local JSONL so the HUD
  // can read them without a proxy. Include them here too; `report` already
  // does, and `latest --tool cursor` must not contradict it.
  const cursorCalls = (!toolFilter || toolFilter === 'cursor')
    ? collectCursorUsageEvents({}).sort((a, b) => b.timestamp - a.timestamp)
    : [];
  const allCalls = [...(Array.isArray(serverCalls) ? serverCalls : []), ...cursorCalls]
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
    .slice(0, 500);
  const calls = toolFilter
    ? (Array.isArray(allCalls) ? allCalls.filter(call => callMatchesTool(call, toolFilter)) : [])
    : (Array.isArray(allCalls) ? allCalls : []);

  const scopeLabel = toolFilter ? ` · ${toolFilter} only` : '';
  console.log(`\n  Tokimeter Latest${scopeLabel}`);

  if (calls.length === 0) {
    console.log(`  No ${toolFilter ? `${toolFilter} ` : ''}usage found in the most recent 500 tracked calls.`);
    if (toolFilter === 'claude') console.log(`  Run some Claude Code turns, or import older sessions with: tokimeter claude-import --backfill`);
    if (toolFilter === 'codex') console.log(`  Run some Codex turns, or import older sessions with: tokimeter codex-import --backfill`);
    console.log('');
    return;
  }

  const scoped = summarizeCalls(calls);
  console.log(`  Today: ${formatCostWithBasis(scoped.todayCost, scoped.todayEstCost)} / ${scoped.todayCalls} calls · Recent total: ${formatCostWithBasis(scoped.totalCost, scoped.totalEstCost)} / ${scoped.totalCalls} calls`);
  if (scoped.totalEstCost > 0) {
    console.log(`  ~ marks API-equivalent estimates from local logs (notional on a subscription).`);
  }

  for (const call of calls.slice(0, 5)) {
    const effort = call.effort ? ` ${call.effort}` : '';
    const reasoning = call.reasoningTokens ? ` / ${call.reasoningTokens} reasoning` : '';
    const context = formatCallContext(call);
    const labels = formatCallLabels(call);
    const when = new Date(Number(call.timestamp) || 0).toLocaleTimeString();
    console.log(`  ${when} · ${call.tool || 'llm'}${context ? ` · ${context}` : ''} · ${call.model || 'unknown'}${effort} · ${labels} · ${call.inputTokens || 0} in / ${call.outputTokens || 0} out${reasoning} · $${(Number(call.totalCost) || 0).toFixed(4)}`);
  }
  console.log('');
}

// ─── Zero-install report ─────────────────────────────────────────────────────
// Reads Claude Code transcripts and Codex rollouts directly from disk.
// No proxy, no shims, no writes — safe to run via npx with zero setup.

// ─── Hermes (Nous Research agent) local usage ────────────────────────────────
// Hermes keeps per-session token totals in ~/.hermes/state.db (SQLite),
// covering every way the local agent is used: tui, cli, desktop app,
// api_server, subagents, and self-hosted Telegram bridging — they all share
// this one sessions table. Only Nous's fully hosted bots leave no local data.

// Read rows without adding a dependency: sqlite3 CLI first (quiet,
// universally present on macOS/Linux), node:sqlite as fallback.
// Commands dispatch at module top level before consts initialize, so the
// query lives in this hoisted function rather than a top-level const.
function readHermesSessionRows(dbPath) {
  if (!existsSync(dbPath)) return [];
  try {
    const schemaOut = execFileSync('sqlite3', ['-readonly', '-json', dbPath, 'PRAGMA table_info(sessions)'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const schema = JSON.parse(schemaOut || '[]');
    const columns = Array.isArray(schema) ? schema.map((column) => column.name).filter(Boolean) : [];
    if (columns.length) {
      const query = buildHermesSessionQuery(columns);
      const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, query], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const rows = JSON.parse(out || '[]');
      if (Array.isArray(rows)) return rows;
    }
  } catch {
    // sqlite3 CLI unavailable or incompatible — try the Node SQLite fallback.
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = db.prepare('PRAGMA table_info(sessions)').all()
      .map((column) => column.name).filter(Boolean);
    const rows = columns.length ? db.prepare(buildHermesSessionQuery(columns)).all() : [];
    db.close();
    return rows;
  } catch {
    // Node <22.5 or unreadable database.
  }
  return [];
}

// One event per Hermes session (Hermes stores totals, not per-turn usage).
// Row→event mapping lives in parsers.js (hermesRowsToEvents) so it's
// fixture-testable without SQLite; this wrapper just reads the database.
function readHermesUsageEvents({ sinceMs = 0 } = {}) {
  return hermesRowsToEvents(readHermesSessionRows(HERMES_STATE_DB), { sinceMs });
}

// ─── opencode: JSON message files + opencode.db (1.2+) ───────────────────────
// Data dir honors OPENCODE_DATA_DIR like opencode itself. Message→event
// mapping lives in parsers.js so it's fixture-testable; this wrapper only
// walks the filesystem / reads the database. Events are deduped by
// externalId in collectLocalUsageEvents, so reading both sources is safe.
function opencodeDataDir() {
  return process.env.OPENCODE_DATA_DIR || join(homedir(), '.local', 'share', 'opencode');
}

function opencodeMessageQuery() {
  return `SELECT id, data FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.tokens') IS NOT NULL`;
}

function readOpencodeDbRows(dbPath) {
  if (!existsSync(dbPath)) return [];
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, opencodeMessageQuery()], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = JSON.parse(out || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    // sqlite3 CLI missing or failed — try the built-in module (Node ≥22.5).
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(opencodeMessageQuery()).all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

function collectOpencodeUsageEvents({ sinceMs = 0 } = {}) {
  const dataDir = opencodeDataDir();
  const events = [];
  events.push(...opencodeRowsToEvents(readOpencodeDbRows(join(dataDir, 'opencode.db')), { sinceMs }));

  const messagesDir = join(dataDir, 'storage', 'message');
  if (existsSync(messagesDir)) {
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(messagesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { /* unreadable dir — fall through with what we have */ }
    for (const dir of sessionDirs) {
      const sessionPath = join(messagesDir, dir.name);
      let files = [];
      try {
        // mtime gate per file is cheaper than parsing every historical message.
        files = readdirSync(sessionPath).filter((f) => f.startsWith('msg_') && f.endsWith('.json'));
      } catch { continue; }
      for (const file of files) {
        const filePath = join(sessionPath, file);
        try {
          if (statSync(filePath).mtimeMs < sinceMs) continue;
        } catch { continue; }
        const event = readOpencodeMessageFile(filePath, { sinceMs });
        if (event) events.push(event);
      }
    }
  }
  return events;
}

// ─── Cline: task dirs under editor globalStorage (or the cline CLI dir) ─────
// One directory per task holding ui_messages.json (+ task_metadata.json for
// model attribution). Parsing lives in parsers.js (readClineTaskEvents); this
// wrapper only enumerates the known storage locations that exist.
function clineTaskRoots() {
  const home = homedir();
  const editorRoots = process.platform === 'darwin'
    ? ['Library/Application Support']
    : process.platform === 'win32'
      ? [process.env.APPDATA || join(home, 'AppData', 'Roaming')]
      : ['.config'];
  const editors = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const roots = [];
  for (const base of editorRoots) {
    for (const editor of editors) {
      roots.push(join(home, base, editor, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'));
    }
  }
  roots.push(join(home, '.cline', 'data', 'tasks'));
  roots.push(join(home, '.cline', 'tasks'));
  if (process.env.CLINE_TASKS_DIR) roots.unshift(process.env.CLINE_TASKS_DIR);
  return roots.filter((dir) => existsSync(dir));
}

function collectClineUsageEvents({ sinceMs = 0 } = {}) {
  const events = [];
  for (const root of clineTaskRoots()) {
    let taskDirs = [];
    try {
      taskDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { continue; }
    for (const dir of taskDirs) {
      const taskDir = join(root, dir.name);
      try {
        // ui_messages.json is appended throughout a task; its mtime gates
        // cheaply which tasks can hold events in the window.
        if (statSync(join(taskDir, 'ui_messages.json')).mtimeMs < sinceMs) continue;
      } catch { continue; }
      events.push(...readClineTaskEvents(taskDir, { sinceMs }));
    }
  }
  const dataDirs = [process.env.CLINE_DATA_DIR, join(homedir(), '.cline', 'data')].filter(Boolean);
  const seenSessionRoots = new Set();
  for (const dataDir of dataDirs) {
    const sessionsRoot = join(dataDir, 'sessions');
    if (!existsSync(sessionsRoot) || seenSessionRoots.has(sessionsRoot)) continue;
    seenSessionRoots.add(sessionsRoot);
    let sessionDirs = [];
    try { sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const dir of sessionDirs) {
      const sessionDir = join(sessionsRoot, dir.name);
      try {
        if (statSync(sessionDir).mtimeMs < sinceMs) continue;
      } catch { continue; }
      events.push(...readClineSessionEvents(sessionDir, { sinceMs }));
    }
  }
  return events;
}

// ─── GitHub Copilot CLI: OTel JSONL exports ──────────────────────────────────
// Present when the user enables Copilot CLI's OpenTelemetry file exporter
// (COPILOT_OTEL_FILE_EXPORTER_PATH, default dir ~/.copilot/otel). Without the
// exporter Copilot CLI leaves no local usage data to read.
function collectCopilotUsageEvents({ sinceMs = 0 } = {}) {
  const dirs = [join(homedir(), '.copilot', 'otel')];
  const explicit = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (explicit) dirs.unshift(existsSync(explicit) && statSync(explicit).isFile() ? dirname(explicit) : explicit);
  const events = [];
  const seenFiles = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir) || seenFiles.has(dir)) continue;
    seenFiles.add(dir);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
    } catch { continue; }
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        if (statSync(filePath).mtimeMs < sinceMs) continue;
      } catch { continue; }
      events.push(...readCopilotOtelEvents(filePath, { sinceMs }));
    }
  }
  return events;
}

function collectGrokUsageEvents({ sinceMs = 0 } = {}) {
  if (!existsSync(GROK_UNIFIED_LOG)) return [];
  const sessionMeta = readGrokSessionMeta(GROK_SESSIONS_DIR);
  return readGrokUsageEvents(GROK_UNIFIED_LOG, { sinceMs, sessionMeta });
}

// Proxy-routed API calls and explicit imports (including Aider histories) live
// in the same immutable JSONL store. Include them in report/cloud collection;
// direct-reader copies dedupe by externalId below.
function collectPersistedUsageEvents({ sinceMs = 0, toolFilter = null } = {}) {
  if (!existsSync(CALLS_FILE)) return [];
  const events = [];
  try {
    for (const line of readFileSync(CALLS_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const timestamp = Number(event?.timestamp) || 0;
      if (!timestamp || timestamp < sinceMs) continue;
      if (toolFilter && !callMatchesTool(event, toolFilter)) continue;
      const hasUsage = Number(event.inputTokens) > 0 || Number(event.outputTokens) > 0
        || Number(event.cachedTokens) > 0 || Number(event.cacheCreationTokens) > 0
        || Number(event.totalCost) > 0;
      if (hasUsage) events.push(event);
    }
  } catch {
    return [];
  }
  return events;
}

function collectLocalUsageEvents({ maxAgeMs, toolFilter = null, providerFilter = null } = {}) {
  const sinceMs = Date.now() - maxAgeMs;
  const events = [];
  const seenIds = new Set();
  const addEvents = (list) => {
    for (const event of list) {
      const id = event.externalId || `${event.timestamp}-${event.model}-${event.inputTokens}-${event.outputTokens}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      events.push(event);
    }
  };

  addEvents(collectPersistedUsageEvents({ sinceMs, toolFilter }));

  if (!toolFilter || toolFilter === 'claude') {
    for (const file of recentClaudeTranscriptFiles({ limit: 2000, maxAgeMs })) {
      addEvents(readClaudeUsageEvents(file, { sinceMs }));
    }
  }
  if (!toolFilter || toolFilter === 'codex') {
    for (const file of recentCodexRolloutFiles({ limit: 2000, maxAgeMs })) {
      addEvents(readCodexTokenEvents(file, { sinceMs }));
    }
  }
  if (!toolFilter || toolFilter === 'grok') {
    addEvents(collectGrokUsageEvents({ sinceMs }));
  }
  if (!toolFilter || toolFilter === 'hermes') {
    addEvents(readHermesUsageEvents({ sinceMs }));
  }
  if (!toolFilter || toolFilter === 'opencode') {
    addEvents(collectOpencodeUsageEvents({ sinceMs }));
  }
  if (!toolFilter || toolFilter === 'cline') {
    addEvents(collectClineUsageEvents({ sinceMs }));
  }
  if (!toolFilter || toolFilter === 'copilot') {
    addEvents(collectCopilotUsageEvents({ sinceMs }));
  }
  if (!toolFilter || toolFilter === 'cursor') {
    addEvents(collectCursorUsageEvents({ sinceMs }));
  }

  for (const event of events) {
    event.pricingConfidence = event.pricingConfidence || getPricingSource(event.model || '').confidence;

    // Calls recorded by older Tokimeter releases may contain the unknown-model
    // $2/$8 heuristic in totalCost. Migrate that value in memory only: reports
    // exclude it from priced totals and show it as a separate rough estimate.
    if (event.pricingConfidence === 'fallback' && Number(event.totalCost) > 0) {
      event.roughEstimateCost = Number(event.roughEstimateCost) || Number(event.totalCost);
      event.totalCost = 0;
      event.inputCost = 0;
      event.outputCost = 0;
    }

    // A tool-reported billed cost (e.g. Hermes actual_cost_usd) wins over
    // our estimate.
    if (Number(event.totalCost) > 0) continue;
    const disjoint = event.provider === 'anthropic' || event.cachedDisjoint === true;
    const cost = priceCall(
      event.model,
      event.inputTokens || 0,
      event.outputTokens || 0,
      event.cachedTokens || 0,
      event.cacheCreationTokens || 0,
      { cachedIncludedInInput: !disjoint }
    );
    event.inputCost = cost.inputCost;
    event.outputCost = cost.outputCost;
    event.totalCost = cost.totalCost;
    event.roughEstimateCost = cost.roughEstimateCost || 0;
    event.pricingConfidence = cost.pricingSource;
  }
  return events
    .filter((event) => !providerFilter || normalizeProviderFilter(event.provider) === providerFilter)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Agent roster + skill usage across recent Claude main transcripts. Main
// transcripts carry the Task/Skill tool_use blocks; subagent files yield
// nothing here (they hold token usage, read by collectLocalUsageEvents).
function collectClaudeAgentActivities({ maxAgeMs } = {}) {
  const activities = [];
  for (const file of recentClaudeTranscriptFiles({ limit: 2000, maxAgeMs })) {
    const a = readClaudeAgentActivity(file);
    if ((a.agents && a.agents.length) || (a.skills && a.skills.length)) activities.push(a);
  }
  return activities;
}

async function runReport(reportArgs) {
  const daysArg = reportArgs.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, parseInt(daysArg?.split('=')[1] || '30', 10) || 30);
  const toolFilter = parseToolFilter(reportArgs);
  const providerFilter = parseProviderFilter(reportArgs);
  const asJson = reportArgs.includes('--json');

  const maxAgeMs = days * 86400 * 1000;
  const events = collectLocalUsageEvents({ maxAgeMs, toolFilter, providerFilter });
  // Agent activity only applies to Claude; skip the extra read pass when filtered elsewhere.
  const activities = (!providerFilter && (!toolFilter || toolFilter === 'claude'))
    ? collectClaudeAgentActivities({ maxAgeMs })
    : [];
  const report = buildReport(events, { days, toolFilter, providerFilter, activities });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (reportArgs.includes('--md')) { process.stdout.write(renderReportMarkdown(report)); return; }
  if (reportArgs.includes('--html')) { process.stdout.write(renderReportHtml(report)); return; }
  printReport(report);
  if (reportArgs.includes('--orchestration')) printOrchestration(report.orchestration);
}

// ─── Card: "My month in AI" shareable SVG (opt-in, metadata-only) ────────────
// Writes an SVG locally; nothing is uploaded. Card content excludes projects,
// paths, and session ids by construction (see buildMonthCard).
async function runCard(cardArgs) {
  const monthArg = cardArgs.find(arg => arg.startsWith('--month='))?.split('=')[1];
  const month = /^\d{4}-\d{2}$/.test(monthArg || '') ? monthArg : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const monthStartMs = Date.UTC(y, m - 1, 1);
  if (monthStartMs > Date.now()) {
    console.error(`  ${month} hasn't started yet.`);
    process.exitCode = 1;
    return;
  }

  const events = collectLocalUsageEvents({ maxAgeMs: Math.max(1, Date.now() - monthStartMs) });
  const card = buildMonthCard(events, { month });

  if (cardArgs.includes('--json')) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }
  const svg = renderMonthCardSvg(card);
  if (cardArgs.includes('--stdout')) {
    process.stdout.write(svg);
    return;
  }
  const outArg = cardArgs.find(arg => arg.startsWith('--out='))?.split('=')[1];
  const outPath = outArg || `tokimeter-card-${month}.svg`;
  writeFileSync(outPath, svg);
  console.log(`\n  My month in AI · ${card.monthLabel}`);
  console.log(`  ${'═'.repeat(50)}`);
  console.log(`  ~$${card.totals.cost.toFixed(2)} est. · ${card.totals.calls} calls · ${card.activeDays} active days`);
  console.log(`\n  Card written to ${outPath}`);
  console.log(`  Built from local token metadata only — no prompts, projects, or session ids.`);
  console.log(`  Nothing was uploaded; sharing it is up to you.\n`);
}

// ─── Cursor CLI: stop-hook capture + status-line HUD ─────────────────────────
// Cursor's stop/subagentStop hooks pipe exact per-turn token usage as JSON on
// stdin. This command (registered in ~/.cursor/hooks.json by `tokimeter setup
// cursor`) prices the payload and appends one metadata-only record to
// ~/.tokimeter/cursor-usage.jsonl. It must never fail loudly — a hook error
// should never disturb the user's Cursor turn.
async function runCursorCapture() {
  try {
    const body = await new Promise((resolve) => {
      if (process.stdin.isTTY) return resolve('');
      let data = '';
      const timer = setTimeout(() => resolve(data), 2000);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
      process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    });
    let payload = null;
    try { payload = JSON.parse(body); } catch { return; }
    const record = cursorStopPayloadToRecord(payload);
    if (!record) return;

    // Price at capture time so the status line can sum costs with a pure file
    // read. Cursor reports disjoint buckets (input excludes cache read/write).
    const priced = priceCall(record.model, record.inputTokens, record.outputTokens,
      record.cachedTokens, record.cacheCreationTokens, { cachedIncludedInInput: false });
    if (priced) {
      record.totalCost = priced.totalCost;
      record.roughEstimateCost = priced.roughEstimateCost || 0;
      record.pricingConfidence = priced.pricingSource;
    }

    ensureDataDir();
    appendFileSync(CURSOR_USAGE_LOG, JSON.stringify(record) + '\n');
  } catch {
    // Swallow everything: hooks are fail-open by design.
  }
}

function collectCursorUsageEvents({ sinceMs = 0 } = {}) {
  return readCursorUsageEvents(CURSOR_USAGE_LOG, { sinceMs });
}

// Import a usage CSV exported from cursor.com's dashboard — the only record of
// desktop in-editor chat, which fires no hooks. Rows append to the same local
// capture log; content-derived ids make re-imports idempotent. Cursor's own
// billed Cost column is kept as authoritative.
async function runCursorImport(importArgs) {
  const path = importArgs.find((arg) => !arg.startsWith('--'));
  if (!path) {
    console.error(`  Usage: tokimeter cursor-import <usage.csv>`);
    console.error(`  Export it from cursor.com → Settings → Usage → Export CSV.`);
    process.exitCode = 1;
    return;
  }
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`  ❌ Could not read ${path}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const records = parseCursorUsageCsv(text);
  if (!records.length) {
    console.error(`  No usage rows found — is this a Cursor dashboard usage export?`);
    process.exitCode = 1;
    return;
  }

  const existing = new Set(readCursorUsageEvents(CURSOR_USAGE_LOG).map((e) => e.externalId));
  let added = 0;
  ensureDataDir();
  for (const record of records) {
    if (existing.has(`cursor:${record.generationId}`)) continue;
    appendFileSync(CURSOR_USAGE_LOG, JSON.stringify(record) + '\n');
    added += 1;
  }
  const skipped = records.length - added;
  console.log(`\n  Imported ${added} Cursor usage row${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already present)` : ''}.`);
  console.log(`  See them: tokimeter report --tool cursor`);
  console.log(`  Note: rows overlap hook-captured turns only if the export covers the`);
  console.log(`  same requests — the hook records agent turns, the CSV covers all usage.`);
  console.log(`  If totals look doubled for a period, prefer one source for that range.\n`);
}

// ─── Grok Build: Stop-hook budget pulse ──────────────────────────────────────
// Grok Build has no custom status-line API, but its hooks fire on every turn
// end. `tokimeter setup grok` registers a Stop hook that runs this command: it
// sums the last 5 hours of Grok spend from the logs Grok already writes and,
// when a budget.grok5h threshold is crossed, raises ONE native desktop
// notification per threshold band (80% / 100%), rate-limited so it never nags.
// No payload fields are read; nothing is recorded; always exits 0.
async function runGrokPulse() {
  try {
    let budget = 0;
    try { budget = Number(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))?.budget?.grok5h || 0); } catch {}
    if (!(budget > 0)) return;

    const sinceMs = Date.now() - 5 * 3600 * 1000;
    const events = [
      ...collectGrokUsageEvents({ sinceMs }),
      ...readHermesUsageEvents({ sinceMs }).filter((event) => event.provider === 'xai' && String(event.billingProvider || '').startsWith('xai')),
    ];
    for (const event of events) {
      if (Number(event.totalCost) > 0) continue;
      const priced = priceCall(event.model, event.inputTokens || 0, event.outputTokens || 0,
        event.cachedTokens || 0, event.cacheCreationTokens || 0,
        { cachedIncludedInInput: event.provider !== 'anthropic' && event.cachedDisjoint !== true });
      event.totalCost = priced.totalCost;
    }
    const spent = events.reduce((sum, e) => sum + (Number(e.totalCost) || 0), 0);
    const pct = Math.round((spent / budget) * 100);
    const band = pct >= 100 ? 100 : (pct >= 80 ? 80 : 0);
    if (band === 0) return;

    let state = {};
    try { state = JSON.parse(readFileSync(GROK_PULSE_STATE, 'utf8')) || {}; } catch {}
    const last = Number(state.lastNotifiedAt) || 0;
    const lastBand = Number(state.lastBand) || 0;
    // Re-notify only on a band upgrade, or after 30 minutes in the same band.
    if (band <= lastBand && Date.now() - last < 30 * 60 * 1000) return;

    const message = `Grok 5h window ~$${spent.toFixed(2)} of ~$${budget.toFixed(2)} (${pct}%)`;
    notifyDesktop('Tokimeter', message);
    ensureDataDir();
    writeFileSync(GROK_PULSE_STATE, JSON.stringify({ lastNotifiedAt: Date.now(), lastBand: band }));
  } catch {
    // Hooks are fail-open; a pulse failure must never disturb the Grok turn.
  }
}

function notifyDesktop(title, message) {
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e',
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
      ], { timeout: 3000, stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execFileSync('notify-send', [title, message], { timeout: 3000, stdio: 'ignore' });
    }
  } catch {
    // No notifier available — stay silent.
  }
}

// Register the pulse as a Grok Build Stop hook. Grok merges every JSON file in
// ~/.grok/hooks/, so Tokimeter keeps a file of its own and never touches
// anyone else's hooks.
function ensureGrokPulseHook() {
  try {
    mkdirSync(join(GROK_HOME, 'hooks'), { recursive: true });
    const hook = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `node ${JSON.stringify(CLI_PATH)} grok-pulse`, timeout: 10 }] },
        ],
      },
    };
    writeFileSync(GROK_HOOK_FILE, JSON.stringify(hook, null, 2) + '\n');
    return { ok: true, detail: `Stop hook in ${GROK_HOOK_FILE}` };
  } catch (err) {
    return { ok: false, detail: `not configured: ${err.message}` };
  }
}

// Wire the Tokimeter HUD + usage capture into Cursor CLI:
//  - statusLine in ~/.cursor/cli-config.json (spec-compatible with Claude's)
//  - stop/subagentStop hooks in ~/.cursor/hooks.json → tokimeter cursor-capture
// Both are additive and reversible; any existing statusLine is backed up and
// re-rendered beneath ours, and existing hooks are preserved.
function ensureCursorInline() {
  try {
    ensureDataDir();
    mkdirSync(CURSOR_HOME, { recursive: true });
    writeCursorStatuslineScript();

    // cli-config.json: install our statusLine, backing up any existing one.
    let config = {};
    if (existsSync(CURSOR_CLI_CONFIG)) {
      try {
        config = JSON.parse(readFileSync(CURSOR_CLI_CONFIG, 'utf8')) || {};
      } catch (err) {
        return { ok: false, detail: `not configured: ${CURSOR_CLI_CONFIG} is not parseable JSON (${err.message})` };
      }
    }
    const current = config.statusLine;
    const ours = (value) => Boolean(value && typeof value === 'object'
      && typeof value.command === 'string' && value.command.includes(CURSOR_STATUSLINE_SCRIPT));
    if (current && !ours(current) && !existsSync(CURSOR_STATUSLINE_PREV)) {
      writeFileSync(CURSOR_STATUSLINE_PREV, JSON.stringify({ statusLine: current }, null, 2));
    }
    config.statusLine = {
      type: 'command',
      command: `node ${JSON.stringify(CURSOR_STATUSLINE_SCRIPT)}`,
      padding: 0,
      updateIntervalMs: 1000,
      timeoutMs: 2000,
    };
    writeFileSync(CURSOR_CLI_CONFIG, JSON.stringify(config, null, 2) + '\n');

    // hooks.json: add our capture hook to stop + subagentStop, preserving
    // whatever is already there.
    let hooksFile = { version: 1, hooks: {} };
    if (existsSync(CURSOR_HOOKS_FILE)) {
      try {
        hooksFile = JSON.parse(readFileSync(CURSOR_HOOKS_FILE, 'utf8')) || hooksFile;
      } catch (err) {
        return { ok: false, detail: `statusline configured, but ${CURSOR_HOOKS_FILE} is not parseable JSON (${err.message})` };
      }
    }
    if (!hooksFile.hooks || typeof hooksFile.hooks !== 'object') hooksFile.hooks = {};
    if (hooksFile.version == null) hooksFile.version = 1;
    const captureCommand = `node ${JSON.stringify(CLI_PATH)} cursor-capture`;
    for (const event of ['stop', 'subagentStop']) {
      const list = Array.isArray(hooksFile.hooks[event]) ? hooksFile.hooks[event] : [];
      if (!list.some((h) => h && typeof h.command === 'string' && h.command.includes('cursor-capture'))) {
        list.push({ command: captureCommand });
      }
      hooksFile.hooks[event] = list;
    }
    writeFileSync(CURSOR_HOOKS_FILE, JSON.stringify(hooksFile, null, 2) + '\n');

    return { ok: true, detail: `statusLine in ${CURSOR_CLI_CONFIG} + usage hook in ${CURSOR_HOOKS_FILE}` };
  } catch (err) {
    return { ok: false, detail: `not configured: ${err.message}` };
  }
}

// The Cursor status line: Tokimeter HUD rendered above the prompt. Reads the
// payload Cursor pipes on stdin (model, context window) and sums today/5h
// spend from the pre-priced capture log — pure file reads, no network, no
// extra model calls. Any previously configured status line is re-rendered on
// a second row so nothing the user had is lost.
function writeCursorStatuslineScript() {
  const script = `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const USAGE_LOG = ${JSON.stringify(CURSOR_USAGE_LOG)};
const PREV_PATH = ${JSON.stringify(CURSOR_STATUSLINE_PREV)};
const SETTINGS_PATH = ${JSON.stringify(SETTINGS_FILE)};
const TIMEOUT_MS = 400;

function readStdinPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let body = '';
    const timer = setTimeout(() => resolve(parse(body)), TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(parse(body)); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}
function parse(body) { try { return JSON.parse(body); } catch { return null; } }

function readRecords() {
  try {
    if (!existsSync(USAGE_LOG)) return [];
    const lines = readFileSync(USAGE_LOG, 'utf8').split(/\\r?\\n/);
    const records = [];
    const seen = new Set();
    for (const line of lines.slice(-2000)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (/^grok-/i.test(String(record.model || '')) && !record.cursorVersion) continue;
        const id = record.generationId ? 'generation:' + record.generationId : '';
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        records.push(record);
      } catch {}
    }
    return records;
  } catch { return []; }
}

function usageNumber(usage, ...keys) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function budgetFor(key) {
  try {
    return Number(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))?.budget?.[key] || 0);
  } catch { return 0; }
}

async function main() {
  const payload = await readStdinPayload();
  const records = readRecords();
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const fiveHrMs = now - 5 * 3600 * 1000;

  let today = 0, todayCalls = 0, fiveHr = 0, unpriced = 0;
  for (const r of records) {
    const ts = Number(r.ts) || 0;
    const cost = Number(r.totalCost) || 0;
    if (ts >= dayStart.getTime()) { today += cost; todayCalls += 1; if (!cost) unpriced += 1; }
    if (ts >= fiveHrMs) fiveHr += cost;
  }

  const budget = budgetFor('cursor5h');
  const pct = budget > 0 ? Math.round((fiveHr / budget) * 100) : 0;
  const budgetText = budget > 0 ? \` (\${pct}%\${pct >= 80 ? ' ⚠' : ''})\` : '';

  const ctx = payload?.context_window;
  const ctxPct = ctx && ctx.used_percentage != null ? Math.round(Number(ctx.used_percentage)) : null;
  const current = ctx?.current_usage;
  const currentTokens = {
    input: usageNumber(current, 'input_tokens', 'inputTokens'),
    output: usageNumber(current, 'output_tokens', 'outputTokens'),
    cacheRead: usageNumber(current, 'cache_read_tokens', 'cacheReadTokens', 'cache_read_input_tokens'),
    cacheWrite: usageNumber(current, 'cache_write_tokens', 'cacheWriteTokens', 'cache_creation_input_tokens'),
  };
  const hasCurrent = Object.values(currentTokens).some((value) => value > 0);
  const currentAlreadyRecorded = hasCurrent && records.some((record) =>
    Number(record.inputTokens || 0) === currentTokens.input
    && Number(record.outputTokens || 0) === currentTokens.output
    && Number(record.cachedTokens || 0) === currentTokens.cacheRead
    && Number(record.cacheCreationTokens || 0) === currentTokens.cacheWrite);
  // Cursor renders the final status-line frame before its stop hook persists
  // the completed turn. Count the payload's current usage as pending so the
  // HUD never says "0 calls" after a successful first response.
  const pendingCurrent = hasCurrent && !currentAlreadyRecorded;
  const displayCalls = todayCalls + (pendingCurrent ? 1 : 0);
  const model = payload?.model?.display_name || payload?.model?.id || '';
  const parts = [
    \`Tokimeter Cursor today ~$\${today.toFixed(2)} · 5h ~$\${fiveHr.toFixed(2)}\${budgetText} · \${displayCalls} call\${displayCalls === 1 ? '' : 's'}\`,
  ];
  if (pendingCurrent) parts.push('syncing current turn');
  if (ctxPct != null) parts.push(\`ctx \${ctxPct}%\`);
  if (model) parts.push(String(model));
  if (unpriced > 0) parts.push(\`\${unpriced} unpriced\`);
  if (!records.length && !pendingCurrent) {
    parts.length = 0;
    parts.push('Tokimeter Cursor · waiting for first turn (usage hook active)');
    if (model) parts.push(String(model));
  }
  process.stdout.write(parts.join(' · '));

  // Re-render whatever status line the user had before ours, on its own row.
  try {
    if (existsSync(PREV_PATH)) {
      const prev = JSON.parse(readFileSync(PREV_PATH, 'utf8')).statusLine;
      if (prev && typeof prev.command === 'string' && !prev.command.includes('cursor-statusline.mjs')) {
        const { spawn } = await import('node:child_process');
        await new Promise((resolve) => {
          const child = spawn(prev.command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
          let out = '';
          const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 600);
          try { child.stdin.write(JSON.stringify(payload || {})); child.stdin.end(); } catch {}
          child.stdout.on('data', (chunk) => { out += chunk; });
          child.on('close', () => {
            clearTimeout(timer);
            if (out.trim()) process.stdout.write('\\n' + out.replace(/[\\r\\n]+$/, '').slice(0, 300));
            resolve();
          });
          child.on('error', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  } catch {}
}

main().catch(() => process.exit(0));
`;
  writeFileSync(CURSOR_STATUSLINE_SCRIPT, script, { mode: 0o755 });
}

// Cross-tool "used together" windows. Correlation only — never presented as
// one tool directing another (see buildOrchestrationReport's basis string).
function printOrchestration(orch) {
  if (!orch) return;
  const t = orch.totals;
  console.log(`\n  Orchestration · overlapping multi-tool usage`);
  console.log(`  ${'═'.repeat(50)}`);
  if (!t.orchestratedWindows) {
    console.log(`  No windows where two or more tools were active in the same`);
    console.log(`  project within ${orch.gapMinutes} minutes of each other.\n`);
    return;
  }
  console.log(`  ${t.orchestratedWindows} overlapping window${t.orchestratedWindows === 1 ? '' : 's'} · ~$${t.orchestratedCost.toFixed(2)}${t.orchestratedCostShare != null ? ` (${t.orchestratedCostShare}% of all spend)` : ''}`);
  console.log(`  Heuristic: tools used together in a project, not proof of delegation.\n`);
  for (const p of orch.projects.slice(0, 8)) {
    const split = p.perTool.map(x => `${x.tool} ~$${x.cost.toFixed(2)}`).join(' · ');
    console.log(`  ${p.project}`);
    console.log(`    ${p.windows} window${p.windows === 1 ? '' : 's'} · ${p.topCombination}`);
    console.log(`    ${split}`);
  }
  if (orch.unattributed.events > 0) {
    console.log(`\n  ${orch.unattributed.events} events had no project path (~$${orch.unattributed.cost.toFixed(2)}) — excluded from correlation.`);
  }
  console.log('');
}

// ─── Trace: explain one session (cost, models, delegation, cache) ────────────
async function runTrace(traceArgs) {
  const asJson = traceArgs.includes('--json');
  const daysArg = traceArgs.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, parseInt(daysArg?.split('=')[1] || '30', 10) || 30);
  const query = traceArgs.find(arg => !arg.startsWith('--')) || '';

  const events = collectLocalUsageEvents({ maxAgeMs: days * 86400 * 1000 });
  const result = buildSessionTrace(events, query);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.matches) {
    console.log(`\n  Tokimeter Trace`);
    console.log(`  ${'═'.repeat(50)}`);
    if (!result.matches.length) {
      console.log(query
        ? `  No session id starting with "${query}" in the last ${days} days.\n`
        : `  No sessions with usage in the last ${days} days.\n`);
      return;
    }
    console.log(query
      ? `  "${query}" matches ${result.matches.length} sessions — be more specific:\n`
      : `  Recent sessions (pass an id or unique prefix):\n`);
    for (const m of result.matches) {
      console.log(`  ${m.sessionId.slice(0, 12)}  ${m.tool.padEnd(12)} ~$${m.cost.toFixed(2)} · ${m.turns} turns · ${m.endedAt.slice(0, 16).replace('T', ' ')}${m.project ? ` · ${shortenPath(String(m.project))}` : ''}`);
    }
    console.log('');
    return;
  }

  const t = result.trace;
  console.log(`\n  Tokimeter Trace · ${t.sessionId}`);
  console.log(`  ${'═'.repeat(50)}`);
  console.log(`  ${t.tool}${t.project ? ` · ${shortenPath(String(t.project))}` : ''}`);
  const end = t.endedAt.slice(0, 10) === t.startedAt.slice(0, 10) ? t.endedAt.slice(11, 16) : t.endedAt.slice(0, 16).replace('T', ' ');
  console.log(`  ${t.startedAt.slice(0, 16).replace('T', ' ')} → ${end} UTC · ${t.durationMinutes}m · ${t.turns} turns · ~$${t.cost.toFixed(2)}`);
  console.log(`  Tokens: ${fmtTokens(t.tokens.input)} in · ${fmtTokens(t.tokens.output)} out · ${fmtTokens(t.tokens.cacheRead)} cache read · ${fmtTokens(t.tokens.cacheWrite)} cache write`);

  console.log(`\n  By model`);
  for (const m of t.byModel) console.log(`    ${m.model.padEnd(28)} ~$${m.cost.toFixed(2)} · ${m.turns} turns`);

  console.log(`\n  Delegation`);
  if (t.delegation.basis) {
    console.log(`    ${t.delegation.basis}`);
  } else if (t.delegation.workerTurns > 0) {
    console.log(`    director ~$${t.delegation.directorCost.toFixed(2)} (${t.delegation.directorTurns} turns) · subagents ~$${t.delegation.workerCost.toFixed(2)} (${t.delegation.workerTurns} turns)`);
  } else {
    console.log(`    no subagent turns in this session`);
  }

  console.log(`\n  Cache: ${t.cache.hitRate}% of context served from cache${t.cache.readWriteRatio != null ? ` · ${t.cache.readWriteRatio}× read/write` : ' · no cache writes'}`);

  if (t.topTurns.length) {
    console.log(`\n  Top turns`);
    for (const turn of t.topTurns) {
      console.log(`    ${turn.when.slice(11, 16)}  ${turn.model}  ~$${turn.cost.toFixed(2)} · ${turn.contextTokens} ctx · ${turn.outputTokens} out`);
    }
  }
  console.log(`\n  ~$ = API-equivalent estimate from local metadata, not a bill.\n`);
}

// ─── Savings: where the bill could shift to a cheaper tier (factual) ─────────
async function runSavings(savingsArgs) {
  const daysArg = savingsArgs.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, parseInt(daysArg?.split('=')[1] || '30', 10) || 30);
  const asJson = savingsArgs.includes('--json');

  const policyArg = savingsArgs.find(arg => arg === '--emit-policy' || arg.startsWith('--emit-policy='));

  const events = collectLocalUsageEvents({ maxAgeMs: days * 86400 * 1000 });
  const report = buildSavingsReport(events, { windowDays: days });

  if (policyArg) {
    const format = policyArg.includes('=') ? policyArg.split('=')[1] : 'json';
    console.log(formatRoutingPolicy(buildRoutingPolicy(report), format));
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Savings · last ${days} days`);
  console.log(`  ${'═'.repeat(50)}`);
  if (!report.models.length) {
    console.log(`  No routine-looking premium-model turns found to move cheaper.`);
    console.log(`  (Only Claude and GPT-5.x premium tiers are analyzed today.)\n`);
    return;
  }
  const t = report.totals;
  console.log(`  Routine premium turns cost ~$${t.routineCost.toFixed(2)}; on the cheapest`);
  console.log(`  same-provider tier that slice is ~$${t.atCheaperCost.toFixed(2)} — a ~$${t.savings.toFixed(2)} gap`);
  if (t.monthlySavings != null) console.log(`  (~$${t.monthlySavings.toFixed(2)}/mo at this pace).\n`);

  for (const g of report.models) {
    console.log(`  ${g.model}  →  ${g.cheaperModel}`);
    console.log(`    ${g.routineTurns} of ${g.totalTurns} turns look routine · ~$${g.routineCost.toFixed(2)} → ~$${g.atCheaperCost.toFixed(2)} · save ~$${g.savings.toFixed(2)}`);
  }
  if (report.keptPremium.turns > 0) {
    console.log(`\n  ${report.keptPremium.turns} premium turns look non-routine (large context/output) — correctly premium (~$${report.keptPremium.cost.toFixed(2)}).`);
  }
  console.log(`\n  Heuristic — routine = short prompt + short output + low context. It can't`);
  console.log(`  read prompt difficulty, so this is an upper bound. Nothing is auto-changed.\n`);
}

// ─── Runaway-agent alarm: burn-rate spikes vs your own baseline ──────────────
// Reuses buildBurnReport (parsers.js). Thresholds are tunable like budgets:
//   tokimeter config set budget.burn.factor 3       (× your baseline to flag)
//   tokimeter config set budget.burn.hourlyFloor 1  (min ~$ in the hour)
//   tokimeter config set budget.burn.dailyFloor 5   (min ~$ today)
function readBurnConfig() {
  const num = (path, fallback) => {
    const v = Number(getSetting(path));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    factor: num('budget.burn.factor', 3),
    hourlyFloor: num('budget.burn.hourlyFloor', 1),
    dailyFloor: num('budget.burn.dailyFloor', 5),
  };
}

async function runBurn(burnArgs) {
  const asJson = burnArgs.includes('--json');
  // 14 days gives a stable baseline without drowning the recent hour.
  const events = collectLocalUsageEvents({ maxAgeMs: 14 * 86400 * 1000 });
  const report = buildBurnReport(events, readBurnConfig());

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Burn · runaway-agent check`);
  console.log(`  ${'═'.repeat(50)}`);
  if (report.alerts.length) {
    for (const a of report.alerts) console.log(`  ⚠ ${a.message}`);
    console.log('');
  } else {
    console.log(`  No spikes — recent spend is within your normal range.\n`);
  }

  console.log(`  Last ${report.recentWindowMinutes}m by tool:`);
  for (const [tool, t] of Object.entries(report.tools)) {
    if (!t.hasHistory) {
      console.log(`    ${tool.padEnd(12)} ~$${t.recentCost.toFixed(2)} · baseline not established yet`);
    } else {
      console.log(`    ${tool.padEnd(12)} ~$${t.recentCost.toFixed(2)} · ${t.ratio.toFixed(1)}× typical hour (~$${t.baselineHourly.toFixed(2)})${t.spike ? '  ⚠' : ''}`);
    }
  }
  const d = report.today;
  if (d.baselineDaily != null) {
    console.log(`  Today: ~$${d.cost.toFixed(2)} · ${d.ratio.toFixed(1)}× your typical day (~$${d.baselineDaily.toFixed(2)})${d.spike ? '  ⚠' : ''}`);
  }
  console.log(`\n  A spike = ≥ ${report.factor}× your baseline and over the floor. Tune: tokimeter config set budget.burn.factor 4\n`);
}

// ─── Plan: forward-looking headroom against your own budgets ─────────────────
// The inverse of `limits` — how much room is left in each window and how long
// until you reach a budget YOU set, at your recent pace. Reuses the budget
// keys from `limits`; honest when no budget is set (shows pace, no ceiling).
async function runPlan(planArgs) {
  const asJson = planArgs.includes('--json');
  const paceArg = planArgs.find(arg => arg.startsWith('--pace='));
  const paceWindowMinutes = Math.max(5, parseInt(paceArg?.split('=')[1] || '60', 10) || 60);

  // A week of events covers the weekly window; pace uses only the last hour.
  const events = collectLocalUsageEvents({ maxAgeMs: 8 * 86400 * 1000 });
  const budgets = {
    claude: { fiveHour: readBudgetEnv('TOKIMETER_CLAUDE_5H_BUDGET'), weekly: readBudgetEnv('TOKIMETER_CLAUDE_WEEKLY_BUDGET') },
    codex: { fiveHour: readBudgetEnv('TOKIMETER_CODEX_5H_BUDGET'), weekly: readBudgetEnv('TOKIMETER_CODEX_WEEKLY_BUDGET') },
    grok: { fiveHour: readBudgetEnv('TOKIMETER_GROK_5H_BUDGET'), weekly: readBudgetEnv('TOKIMETER_GROK_WEEKLY_BUDGET') },
    global: { daily: readBudgetEnv('TOKIMETER_DAILY_BUDGET'), weekly: readBudgetEnv('TOKIMETER_WEEKLY_BUDGET') },
  };
  const tools = ['claude', 'codex', ...(events.some((e) => e.provider === 'xai') || budgets.grok.fiveHour || budgets.grok.weekly ? ['grok'] : [])];
  const report = buildBurnPlanner(events, { budgets, tools, paceWindowMinutes });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Plan · headroom at your current pace`);
  console.log(`  ${'═'.repeat(50)}`);
  console.log(`  Pace is measured over the last ${paceWindowMinutes} min. Headroom needs a`);
  console.log(`  budget you set — vendors don't publish real quotas.\n`);

  const windowLine = (label, w) => {
    if (w.status === 'no-budget') {
      console.log(`    ${label.padEnd(9)} ~$${w.used.toFixed(2)} used · no budget set`);
      return;
    }
    const eta = w.timeToLimit != null
      ? `~${w.timeToLimit} ${w.timeUnit}${w.timeToLimit === 1 ? '' : 's'} to limit`
      : (w.status === 'over' ? 'over budget' : 'idle — no ETA');
    const tok = w.tokensRemaining != null ? ` · ~${fmtTokens(w.tokensRemaining)} tok` : '';
    const flag = w.status === 'over' ? '  ⚠ over' : w.status === 'approaching' ? '  ⚠' : '';
    console.log(`    ${label.padEnd(9)} ~$${w.remaining.toFixed(2)} left of ~$${w.budget.toFixed(2)} (${w.percentUsed}%)${tok} · ${eta}${flag}`);
  };

  const anyBudget = (t) => t.fiveHour.status !== 'no-budget' || t.weekly.status !== 'no-budget';
  for (const t of report.tools) {
    console.log(`  ${t.tool}  ·  pace ~$${t.pace.perHourCost.toFixed(2)}/hr · ${fmtTokens(t.pace.perHourTokens)} tok/hr`);
    windowLine('5h window', t.fiveHour);
    windowLine('weekly', t.weekly);
    if (!anyBudget(t)) {
      console.log(`    Set one: tokimeter config set budget.${t.tool}5h 25`);
    }
    console.log('');
  }

  const g = report.global;
  console.log(`  all tools  ·  pace ~$${g.pace.perHourCost.toFixed(2)}/hr`);
  windowLine('today', g.daily);
  windowLine('weekly', g.weekly);
  console.log(`\n  ~$ = API-equivalent estimate. ETA assumes your last-${paceWindowMinutes}-min pace holds.\n`);
}

// ─── Delegation report: director vs subagent-worker economics ────────────────
// Attribution per tool (docs/BUILD_PLAN.md): claude-code per-turn via
// isSidechain; hermes per-session via source='subagent' + parent_session_id;
// codex/grok have no role markers and are reported as such, never guessed.

async function runAgents(agentsArgs) {
  const daysArg = agentsArgs.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, parseInt(daysArg?.split('=')[1] || '30', 10) || 30);
  const asJson = agentsArgs.includes('--json');

  const maxAgeMs = days * 86400 * 1000;
  const events = collectLocalUsageEvents({ maxAgeMs });
  const report = buildDelegationReport(events);
  report.windowDays = days;
  report.agentBreakdown = buildAgentBreakdown(events, collectClaudeAgentActivities({ maxAgeMs }));

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Agents · last ${days} days`);
  console.log(`  ${'═'.repeat(50)}`);
  const t = report.totals;
  if (t.workerCostShare == null) {
    console.log('  No subagent usage found in this window.');
    console.log('  (Claude Code Task-tool subagents and Hermes subagent sessions are detected.)\n');
    return;
  }
  console.log(`  Directors  ~$${t.directorCost.toFixed(2)}   Workers  ~$${t.workerCost.toFixed(2)}   (${t.workerCostShare}% of delegated-session spend on workers)\n`);

  for (const [tool, section] of Object.entries(report.tools)) {
    if (section.attribution === 'none') {
      console.log(`  ${tool}: role attribution unavailable — ${section.note}`);
      continue;
    }
    if (!section.delegationSessions) continue;
    console.log(`  ${tool} (${section.attribution})`);
    console.log(`    Sessions with delegation: ${section.delegationSessions}`);
    console.log(`    Director side: ~$${section.director.cost.toFixed(2)} · ${section.director.calls} ${section.attribution === 'per-turn' ? 'turns' : 'sessions'} · ${fmtTokens(section.director.outputTokens)} out`);
    console.log(`    Worker side:   ~$${section.worker.cost.toFixed(2)} · ${section.worker.calls} ${section.attribution === 'per-turn' ? 'turns' : 'sessions'} · ${fmtTokens(section.worker.outputTokens)} out`);
    for (const pair of section.pairs.slice(0, 6)) {
      console.log(`      ${pair.pair}  ~$${pair.cost.toFixed(2)} · ${pair.calls}x`);
    }
    // Advisor: factual counterfactuals, never "you should".
    const adv = section.advisor || {};
    if (adv.workerVsDirector) {
      const w = adv.workerVsDirector;
      const verb = w.delta >= 0 ? 'more' : 'less';
      console.log(`    Workers cost ~$${w.actualCost.toFixed(2)}; the same tokens at the director model's rates ≈ ~$${w.atDirectorCost.toFixed(2)} (~$${Math.abs(w.delta).toFixed(2)} ${verb})${w.workersSkipped ? ` · ${w.workersSkipped} skipped (unpriced model)` : ''}.`);
    }
    if (adv.directorGrunt) {
      const g = adv.directorGrunt;
      console.log(`    ${g.turns} small director turn${g.turns === 1 ? '' : 's'} cost ~$${g.actualCost.toFixed(2)}; the same tokens on the cheapest worker model ≈ ~$${g.atCheapestWorkerCost.toFixed(2)}.`);
    }
    console.log('');
  }

  // Agent-type breakdown + skills (Claude Task-tool + Skill invocations).
  const ab = report.agentBreakdown;
  if (ab && ab.agents.length) {
    console.log(`  By agent type (Claude subagents)`);
    for (const a of ab.agents) {
      const models = a.models.length ? ` · ${a.models.join(', ')}` : '';
      console.log(`    ${a.subagentType.padEnd(18)} ~$${a.cost.toFixed(2)} · ${a.invocations} run${a.invocations === 1 ? '' : 's'} · ${a.turns} turns${models}`);
      if (a.sampleDescriptions.length) {
        console.log(`      e.g. ${a.sampleDescriptions.slice(0, 3).join(' · ')}`);
      }
    }
    if (ab.coverage.unattributedTurns > 0) {
      console.log(`    (${ab.coverage.unattributedTurns} worker turns had no Task-call type — older inline sidechains.)`);
    }
    console.log('');
  }
  if (ab && ab.skills.length) {
    console.log(`  Skills invoked: ${ab.skills.map((s) => `${s.skill}${s.count > 1 ? ` ×${s.count}` : ''}`).join(' · ')}\n`);
  }

  console.log('  ~$ = API-equivalent estimate from exact local token counts. Counterfactuals re-price your own tokens; nothing is recommended.\n');
}

// ─── Limits: 5-hour rolling window + weekly usage, with optional budgets ─────
// Anthropic/OpenAI don't publish exact subscription quotas, so Tokimeter shows
// your usage inside the same windows the vendors meter (5h rolling, weekly)
// and warns against budgets you set yourself.

async function runLimits(limitsArgs) {
  const toolFilter = parseToolFilter(limitsArgs);
  const asJson = limitsArgs.includes('--json');
  // Grok's subscription can be consumed directly or through Hermes xAI OAuth,
  // so that limit view intentionally reads across tools and matches provider.
  const collectedEvents = collectLocalUsageEvents({ maxAgeMs: 8 * 86400 * 1000, toolFilter: toolFilter === 'grok' ? null : toolFilter });
  const events = toolFilter === 'grok' ? collectedEvents.filter((e) => e.provider === 'xai') : collectedEvents;

  const now = Date.now();
  const tools = toolFilter ? [toolFilter] : ['claude', 'codex', ...(events.some((e) => e.provider === 'xai') ? ['grok'] : [])];
  const result = { generatedAt: new Date(now).toISOString(), tools: [] };

  for (const tool of tools) {
    const toolEvents = tool === 'grok'
      ? events.filter((e) => e.provider === 'xai')
      : events.filter((e) => callMatchesTool(e, tool));
    const windowStats = (sinceMs) => {
      const inWindow = toolEvents.filter(e => e.timestamp >= sinceMs);
      const stats = { calls: inWindow.length, cost: 0, tokens: 0 };
      for (const e of inWindow) {
        stats.cost += e.totalCost || 0;
        stats.tokens += (e.inputTokens || 0) + (e.outputTokens || 0)
          + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0);
      }
      stats.cost = round2(stats.cost);
      return stats;
    };

    const fiveHour = windowStats(now - 5 * 3600 * 1000);
    const weekly = windowStats(now - 7 * 86400 * 1000);
    const oldest5h = toolEvents.find(e => e.timestamp >= now - 5 * 3600 * 1000);
    const budgets = {
      fiveHour: readBudgetEnv(`TOKIMETER_${tool.toUpperCase()}_5H_BUDGET`),
      weekly: readBudgetEnv(`TOKIMETER_${tool.toUpperCase()}_WEEKLY_BUDGET`),
    };

    result.tools.push({
      tool,
      fiveHourWindow: {
        ...fiveHour,
        windowOpensAt: oldest5h ? new Date(oldest5h.timestamp).toISOString() : null,
        budget: budgets.fiveHour,
        percentUsed: budgets.fiveHour ? Math.round((fiveHour.cost / budgets.fiveHour) * 100) : null,
      },
      weekly: {
        ...weekly,
        budget: budgets.weekly,
        percentUsed: budgets.weekly ? Math.round((weekly.cost / budgets.weekly) * 100) : null,
      },
      // Codex writes vendor rate-limit snapshots into its rollout logs;
      // Claude Code does not record any rate-limit telemetry locally
      // (verified 2026-07-08), so vendor stays null there and we show the
      // honest rolling windows instead of guessing reset times.
      vendor: tool === 'codex' ? latestCodexVendorLimits() : null,
    });
  }

  const dailyBudget = readBudgetEnv('TOKIMETER_DAILY_BUDGET');
  const weeklyBudget = readBudgetEnv('TOKIMETER_WEEKLY_BUDGET');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const globalToday = round2(events.filter(e => e.timestamp >= todayStart.getTime()).reduce((s, e) => s + (e.totalCost || 0), 0));
  const globalWeek = round2(events.filter(e => e.timestamp >= now - 7 * 86400 * 1000).reduce((s, e) => s + (e.totalCost || 0), 0));
  result.global = {
    todayCost: globalToday,
    dailyBudget,
    dailyPercentUsed: dailyBudget ? Math.round((globalToday / dailyBudget) * 100) : null,
    weekCost: globalWeek,
    weeklyBudget,
    weeklyPercentUsed: weeklyBudget ? Math.round((globalWeek / weeklyBudget) * 100) : null,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Limits${toolFilter ? ` · ${toolFilter} only` : ''}`);
  console.log(`  ${'═'.repeat(50)}`);
  console.log(`  Vendors meter subscriptions on a 5-hour rolling window plus a`);
  console.log(`  weekly cap; exact quotas aren't published. Costs are ~API-equiv.\n`);

  for (const t of result.tools) {
    console.log(`  ${t.tool}`);
    console.log(`    Last 5h:   ~$${t.fiveHourWindow.cost.toFixed(2)} · ${t.fiveHourWindow.calls} calls · ${fmtTokens(t.fiveHourWindow.tokens)} tokens${budgetSuffix(t.fiveHourWindow)}`);
    console.log(`    Last 7d:   ~$${t.weekly.cost.toFixed(2)} · ${t.weekly.calls} calls · ${fmtTokens(t.weekly.tokens)} tokens${budgetSuffix(t.weekly)}`);
    if (t.vendor) {
      const asOf = new Date(t.vendor.timestamp);
      const asOfLabel = `${String(asOf.getHours()).padStart(2, '0')}:${String(asOf.getMinutes()).padStart(2, '0')}`;
      console.log(`    Vendor-reported${t.vendor.planType ? ` (${t.vendor.planType} plan)` : ''}, as of ${asOfLabel}:`);
      if (t.vendor.primary) {
        console.log(`      5h window:  ${vendorWindowLine(t.vendor.primary)}`);
      }
      if (t.vendor.secondary) {
        console.log(`      Weekly:     ${vendorWindowLine(t.vendor.secondary)}`);
      }
    }
    if (!t.fiveHourWindow.budget) {
      console.log(`    Tip: tokimeter config set budget.${t.tool}5h 25   (~$ per 5h window, enables warnings)`);
    }
    console.log('');
  }

  const g = result.global;
  if (g.dailyBudget) {
    console.log(`  Daily budget:  ${pctBar(g.dailyPercentUsed)} ${g.dailyPercentUsed}% of $${g.dailyBudget.toFixed(2)} (~$${g.todayCost.toFixed(2)} today)${warnIfHigh(g.dailyPercentUsed)}`);
  } else {
    console.log(`  Daily budget:  unset — enable with: tokimeter config set budget.daily 50`);
  }
  if (g.weeklyBudget) {
    console.log(`  Weekly budget: ${pctBar(g.weeklyPercentUsed)} ${g.weeklyPercentUsed}% of $${g.weeklyBudget.toFixed(2)} (~$${g.weekCost.toFixed(2)} this week)${warnIfHigh(g.weeklyPercentUsed)}`);
  } else {
    console.log(`  Weekly budget: unset — enable with: tokimeter config set budget.weekly 200`);
  }
  console.log('');
}

// Newest vendor rate-limit snapshot across recent Codex rollouts. These are
// the vendor's own numbers (used_percent + resets_at per window), so they are
// evidence, not estimates — but only trustworthy while fresh. Returns null
// when there is no snapshot from the last 24h.
function latestCodexVendorLimits() {
  let latest = null;
  for (const file of recentCodexRolloutFiles({ limit: 8, maxAgeMs: 2 * 86400 * 1000 })) {
    for (const snap of readCodexRateLimitSnapshots(file)) {
      if (snap.timestamp && (!latest || snap.timestamp > latest.timestamp)) latest = snap;
    }
  }
  if (!latest || Date.now() - latest.timestamp > 24 * 3600 * 1000) return null;

  // A window whose reset time has already passed no longer says anything
  // about current usage — drop it rather than show stale percentages.
  const stillValid = w => (w && (!w.resetsAtMs || w.resetsAtMs > Date.now()) ? w : null);
  const primary = stillValid(latest.primary);
  const secondary = stillValid(latest.secondary);
  if (!primary && !secondary) return null;
  return { timestamp: latest.timestamp, planType: latest.planType, primary, secondary };
}

function vendorWindowLine(window) {
  const percent = Math.round(window.usedPercent);
  let resets = '';
  if (window.resetsAtMs) {
    const deltaMinutes = Math.max(1, Math.round((window.resetsAtMs - Date.now()) / 60000));
    const when = new Date(window.resetsAtMs);
    const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const relative = deltaMinutes >= 1440
      ? `${Math.floor(deltaMinutes / 1440)}d ${Math.floor((deltaMinutes % 1440) / 60)}h`
      : deltaMinutes >= 60
        ? `${Math.floor(deltaMinutes / 60)}h ${deltaMinutes % 60}m`
        : `${deltaMinutes}m`;
    const dayLabel = deltaMinutes >= 1440
      ? `${when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} `
      : '';
    resets = ` · resets in ${relative} (${dayLabel}${clock})`;
  }
  return `${percent}% used${resets}${warnIfHigh(percent)}`;
}

// Session budgets: "warn after $2 or 30 minutes in this session". Env vars
// win over settings (tokimeter config set budget.session.cost 2 /
// budget.session.minutes 30). Warnings only — nothing is ever blocked.
function readSessionBudgets() {
  const cost = Number(process.env.TOKIMETER_SESSION_COST_BUDGET || 0)
    || Number(getSetting('budget.session.cost') || 0);
  const minutes = Number(process.env.TOKIMETER_SESSION_MINUTES_BUDGET || 0)
    || Number(getSetting('budget.session.minutes') || 0);
  return { cost: cost > 0 ? cost : null, minutes: minutes > 0 ? minutes : null };
}

// Tracks one wrapped tool run against the session budgets and notifies once
// per threshold. The interval exists so the minutes warning fires even when
// no calls arrive; unref'd so it never keeps the wrapper alive.
function createSessionBudgetTracker({ startedAt, notify }) {
  const budgets = readSessionBudgets();
  if (!budgets.cost && !budgets.minutes) {
    return { onCall() {}, stop() {} };
  }

  let sessionCost = 0;
  let warnedCost = false;
  let warnedMinutes = false;

  const check = () => {
    if (budgets.cost && !warnedCost && sessionCost >= budgets.cost) {
      warnedCost = true;
      notify(`session at ~$${sessionCost.toFixed(2)} — past your ~$${budgets.cost.toFixed(2)} session budget (informational only)`);
    }
    if (budgets.minutes && !warnedMinutes && Date.now() - startedAt >= budgets.minutes * 60000) {
      warnedMinutes = true;
      const elapsed = Math.round((Date.now() - startedAt) / 60000);
      notify(`session running ${elapsed}m — past your ${budgets.minutes}m session budget (informational only)`);
    }
  };

  const timer = setInterval(check, 30 * 1000);
  timer.unref?.();

  return {
    onCall(call) {
      sessionCost += Number(call?.totalCost) || 0;
      check();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// Budgets: env var wins, then ~/.tokimeter/settings.json (tokimeter config set budget.daily 50).
function readBudgetEnv(name) {
  const fromEnv = Number(process.env[name] || 0);
  if (fromEnv > 0) return fromEnv;
  const settingKey = budgetSettingKey(name);
  const fromSettings = settingKey ? Number(getSetting(settingKey) || 0) : 0;
  return fromSettings > 0 ? fromSettings : null;
}

// Commands dispatch at module top level, before top-level consts initialize —
// keep this a function declaration so it is hoisted.
function budgetSettingKey(name) {
  return {
    TOKIMETER_DAILY_BUDGET: 'budget.daily',
    TOKIMETER_WEEKLY_BUDGET: 'budget.weekly',
    TOKIMETER_CLAUDE_5H_BUDGET: 'budget.claude5h',
    TOKIMETER_CLAUDE_WEEKLY_BUDGET: 'budget.claudeWeekly',
    TOKIMETER_CODEX_5H_BUDGET: 'budget.codex5h',
    TOKIMETER_CODEX_WEEKLY_BUDGET: 'budget.codexWeekly',
  }[name];
}

function budgetSuffix(window) {
  if (!window.budget) return '';
  return ` · ${window.percentUsed}% of ~$${window.budget.toFixed(2)} budget${warnIfHigh(window.percentUsed)}`;
}

function warnIfHigh(percent) {
  if (percent >= 100) return '  ⚠ over budget';
  if (percent >= 80) return `  ⚠ less than ${100 - percent}% remaining`;
  return '';
}

function pctBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

// ─── Model comparison on the user's actual workload ─────────────────────────

async function runCompare(compareArgs) {
  const daysArg = compareArgs.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, parseInt(daysArg?.split('=')[1] || '30', 10) || 30);
  const asJson = compareArgs.includes('--json');
  const events = collectLocalUsageEvents({ maxAgeMs: days * 86400 * 1000 });

  const byModel = new Map();
  for (const e of events) {
    const key = `${e.model || 'unknown'}${e.effort ? ` ${e.effort}` : ''}`;
    const m = byModel.get(key) || {
      model: e.model, label: key, tool: e.tool, provider: e.provider,
      calls: 0, cost: 0, contextTokens: 0, outputTokens: 0, reasoningTokens: 0,
    };
    m.calls += 1;
    m.cost += e.totalCost || 0;
    m.contextTokens += (e.inputTokens || 0) + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0);
    m.outputTokens += e.outputTokens || 0;
    m.reasoningTokens += e.reasoningTokens || 0;
    byModel.set(key, m);
  }

  const rows = [...byModel.values()]
    .sort((a, b) => b.cost - a.cost)
    .map(m => ({
      label: m.label,
      tool: m.tool,
      calls: m.calls,
      cost: round2(m.cost),
      costPerCall: m.calls > 0 ? round2(m.cost / m.calls * 100) / 100 : 0,
      avgContextTokens: m.calls > 0 ? Math.round(m.contextTokens / m.calls) : 0,
      avgOutputTokens: m.calls > 0 ? Math.round(m.outputTokens / m.calls) : 0,
    }));

  // Cheaper-tier usage valued at premium-tier prices: factual "what the same
  // tokens would have cost" statement, per provider.
  const CHEAP = /haiku|mini|nano|flash/i;
  const cheapUse = { anthropic: { turns: 0, actual: 0, atPremium: 0 }, openai: { turns: 0, actual: 0, atPremium: 0 } };
  for (const e of events) {
    if (!CHEAP.test(String(e.model || ''))) continue;
    const bucket = cheapUse[e.provider];
    if (!bucket) continue;
    const premium = e.provider === 'anthropic' ? 'claude-fable-5' : 'gpt-5.5';
    const at = priceCall(premium, e.inputTokens || 0, e.outputTokens || 0, e.cachedTokens || 0,
      e.cacheCreationTokens || 0, { cachedIncludedInInput: e.provider !== 'anthropic' });
    bucket.turns += 1;
    bucket.actual += e.totalCost || 0;
    bucket.atPremium += at.totalCost;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    models: rows,
    cheaperTierUsage: Object.fromEntries(Object.entries(cheapUse)
      .filter(([, v]) => v.turns > 0)
      .map(([k, v]) => [k, { turns: v.turns, actualCost: round2(v.actual), atPremiumTierCost: round2(v.atPremium) }])),
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  Tokimeter Model Comparison · last ${days} days · your actual workload`);
  console.log(`  ${'═'.repeat(66)}`);
  console.log(`  ${'model'.padEnd(28)}${'calls'.padStart(7)}${'$/call'.padStart(9)}${'avg ctx'.padStart(9)}${'avg out'.padStart(9)}${'total'.padStart(10)}`);
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.label.slice(0, 27).padEnd(28)}${String(r.calls).padStart(7)}${('$' + r.costPerCall.toFixed(3)).padStart(9)}${fmtTokens(r.avgContextTokens).padStart(9)}${fmtTokens(r.avgOutputTokens).padStart(9)}${('$' + r.cost.toFixed(2)).padStart(10)}`);
  }

  for (const [provider, v] of Object.entries(result.cheaperTierUsage)) {
    const premium = provider === 'anthropic' ? 'Fable' : 'GPT-5.5';
    console.log(`\n  ${provider}: ${v.turns} turns ran on cheaper tiers for $${v.actualCost.toFixed(2)}; same tokens on ${premium}: $${v.atPremiumTierCost.toFixed(2)}.`);
  }
  console.log(`\n  Costs are API-equivalent estimates from exact local token counts.\n`);
}

function buildReport(events, { days, toolFilter, providerFilter, activities = [] }) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const weekMs = Date.now() - 7 * 86400 * 1000;

  const totals = { cost: 0, roughEstimateCost: 0, unpricedCalls: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
  const today = { cost: 0, roughEstimateCost: 0, unpricedCalls: 0, calls: 0 };
  const week = { cost: 0, roughEstimateCost: 0, unpricedCalls: 0, calls: 0 };
  const byTool = new Map();
  const byProvider = new Map();
  const byAccessPath = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const bySession = new Map();
  const byPricingSource = new Map();
  const reasoningByDay = new Map();
  let cacheReadSavings = 0;

  const bump = (map, key, cost, roughEstimateCost = 0) => {
    const current = map.get(key) || { cost: 0, roughEstimateCost: 0, unpricedCalls: 0, calls: 0 };
    current.cost += cost;
    current.roughEstimateCost += roughEstimateCost;
    if (roughEstimateCost > 0) current.unpricedCalls += 1;
    current.calls += 1;
    map.set(key, current);
  };

  for (const event of events) {
    const cost = Number(event.totalCost) || 0;
    const roughEstimateCost = Math.max(0, Number(event.roughEstimateCost) || 0);
    const pricingSource = normalizePricingConfidence(event.pricingConfidence || getPricingSource(event.model || '').confidence);
    totals.cost += cost;
    totals.roughEstimateCost += roughEstimateCost;
    if (roughEstimateCost > 0) totals.unpricedCalls += 1;
    totals.calls += 1;
    totals.inputTokens += event.inputTokens || 0;
    totals.outputTokens += event.outputTokens || 0;
    totals.cachedTokens += event.cachedTokens || 0;
    totals.cacheCreationTokens += event.cacheCreationTokens || 0;
    totals.reasoningTokens += event.reasoningTokens || 0;

    if (event.timestamp >= todayMs) {
      today.cost += cost;
      today.roughEstimateCost += roughEstimateCost;
      if (roughEstimateCost > 0) today.unpricedCalls += 1;
      today.calls += 1;
    }
    if (event.timestamp >= weekMs) {
      week.cost += cost;
      week.roughEstimateCost += roughEstimateCost;
      if (roughEstimateCost > 0) week.unpricedCalls += 1;
      week.calls += 1;
    }

    bump(byTool, event.tool || 'unknown', cost, roughEstimateCost);
    bump(byProvider, providerDisplayName(event.provider), cost, roughEstimateCost);
    const accessPath = event.accessPath || (event.tool === 'grok' && event.provider === 'xai' ? 'Grok Build (direct)' : null);
    if (accessPath) bump(byAccessPath, accessPath, cost, roughEstimateCost);
    bump(byModel, `${event.model || 'unknown'}${event.effort ? ` ${event.effort}` : ''}`, cost, roughEstimateCost);
    bump(byProject, event.cwd ? shortenPath(String(event.cwd)) : '(unknown project)', cost, roughEstimateCost);
    const day = localDateKey(event.timestamp);
    bump(byDay, day, cost, roughEstimateCost);
    bump(byPricingSource, pricingSource, cost, roughEstimateCost);
    if (event.sessionId) {
      const sessionLabel = `${event.tool || 'llm'} · ${event.cwd ? shortenPath(String(event.cwd)) : '(unknown)'} · ${String(event.sessionId).slice(0, 8)}`;
      bump(bySession, sessionLabel, cost, roughEstimateCost);
    }
    if (event.reasoningTokens) {
      reasoningByDay.set(day, (reasoningByDay.get(day) || 0) + event.reasoningTokens);
    }

    const price = getPrice(event.model);
    if (price && (event.cachedTokens || 0) > 0) {
      const readRate = price.cached > 0 ? price.cached : price.input * 0.1;
      cacheReadSavings += ((event.cachedTokens || 0) / 1_000_000) * Math.max(0, price.input - readRate);
    }
  }

  const toSorted = (map) => [...map.entries()]
    .map(([name, value]) => ({
      name,
      cost: round2(value.cost),
      roughEstimateCost: round2(value.roughEstimateCost),
      unpricedCalls: value.unpricedCalls,
      calls: value.calls,
    }))
    .sort((a, b) => b.cost - a.cost || b.roughEstimateCost - a.roughEstimateCost);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    toolFilter: toolFilter || 'all',
    providerFilter: providerFilter || 'all',
    costBasis: 'priced totals use provider-reported costs or sourced API rates; subscription values are API-equivalent, not invoices; unknown-model fallback is excluded and shown separately',
    totals: { ...totals, cost: round2(totals.cost), roughEstimateCost: round2(totals.roughEstimateCost) },
    today: { ...today, cost: round2(today.cost), roughEstimateCost: round2(today.roughEstimateCost) },
    last7Days: { ...week, cost: round2(week.cost), roughEstimateCost: round2(week.roughEstimateCost) },
    pricingSources: toSorted(byPricingSource),
    cacheReadSavings: round2(cacheReadSavings),
    insights: buildInsights(events, totals),
    delegation: buildDelegationReport(events),
    agentBreakdown: buildAgentBreakdown(events, activities),
    orchestration: buildOrchestrationReport(events),
    burn: buildBurnReport(events, readBurnConfig()),
    savings: buildSavingsReport(events, { windowDays: days }),
    byTool: toSorted(byTool),
    byProvider: toSorted(byProvider),
    byAccessPath: toSorted(byAccessPath),
    byModel: toSorted(byModel),
    byProject: toSorted(byProject),
    bySession: toSorted(bySession).slice(0, 10),
    byDay: [...byDay.entries()]
      .map(([date, value]) => ({
        date,
        cost: round2(value.cost),
        roughEstimateCost: round2(value.roughEstimateCost),
        unpricedCalls: value.unpricedCalls,
        calls: value.calls,
        reasoningTokens: reasoningByDay.get(date) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function normalizePricingConfidence(value) {
  if (value === 'known' || value === 'built-in') return 'verified built-in';
  if (value === 'verified') return 'verified built-in';
  if (value === 'feed' || value === 'community') return 'community feed';
  if (value === 'custom') return 'custom local';
  if (value === 'reported') return 'provider/tool reported';
  return 'fallback / unpriced';
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMinute(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${localDateKey(date)} ${hours}:${minutes}`;
}

// Local, factual observations over the same events the report totals use.
// No prompt content is read — everything derives from token/model metadata.
function buildInsights(events, totals) {
  const insights = {};

  // Cache efficiency: share of context tokens served from cache.
  const contextTokens = totals.inputTokens + totals.cachedTokens + totals.cacheCreationTokens;
  insights.cacheHitRate = contextTokens > 0 ? Math.round((totals.cachedTokens / contextTokens) * 100) : 0;

  // Cache economics per project: a cache write costs ~1.25× input and only
  // pays off if later turns READ it back. Projects that write a lot but read
  // little are running "cold" — sessions not reusing context before the cache
  // expires. We flag those; healthy projects (read ≫ write) stay quiet.
  const cacheByProject = new Map();
  for (const e of events) {
    const write = e.cacheCreationTokens || 0;
    const read = e.cachedTokens || 0;
    if (write === 0 && read === 0) continue;
    const key = e.cwd ? shortenPath(String(e.cwd)) : '(unknown project)';
    const c = cacheByProject.get(key) || { write: 0, read: 0, writeCost: 0 };
    c.write += write;
    c.read += read;
    const price = getPrice(e.model);
    if (price && write > 0) {
      const writeRate = price.cacheWrite > 0 ? price.cacheWrite : price.input * 1.25;
      c.writeCost += (write / 1_000_000) * writeRate;
    }
    cacheByProject.set(key, c);
  }
  // Cold = read is under 2× write (little reuse) AND the write spend is
  // material (over ~$1 in the window, so tiny projects never trip it).
  const coldProjects = [...cacheByProject.entries()]
    .map(([project, c]) => ({
      project,
      cacheWriteTokens: c.write,
      cacheReadTokens: c.read,
      readWriteRatio: c.write > 0 ? Math.round((c.read / c.write) * 10) / 10 : null,
      cacheWriteCost: round2(c.writeCost),
    }))
    .filter(c => c.readWriteRatio != null && c.readWriteRatio < 2 && c.cacheWriteCost >= 1)
    .sort((a, b) => b.cacheWriteCost - a.cacheWriteCost);
  if (coldProjects.length) insights.coldCache = coldProjects.slice(0, 5);

  // Turn-level insights must not include session aggregates (Hermes stores
  // per-session totals, not per-turn usage) — a whole session masquerading
  // as one "turn" would dominate every list.
  const perTurnEvents = events.filter(e => e.source !== 'hermes-state-db');

  // Highest-cost single turns.
  insights.topTurns = [...perTurnEvents]
    .sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0))
    .slice(0, 3)
    .map(e => ({
      when: new Date(e.timestamp).toISOString(),
      tool: e.tool,
      model: `${e.model}${e.effort ? ` ${e.effort}` : ''}`,
      cost: round2(e.totalCost || 0),
      contextTokens: (e.inputTokens || 0) + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0),
      outputTokens: e.outputTokens || 0,
      project: e.cwd ? shortenPath(String(e.cwd)) : null,
    }));

  // Large context driving cost: turns whose context exceeds 150k tokens.
  const LARGE_CONTEXT = 150_000;
  const largeContextTurns = perTurnEvents.filter(e =>
    (e.inputTokens || 0) + (e.cachedTokens || 0) + (e.cacheCreationTokens || 0) >= LARGE_CONTEXT);
  insights.largeContext = {
    threshold: LARGE_CONTEXT,
    turns: largeContextTurns.length,
    cost: round2(largeContextTurns.reduce((s, e) => s + (e.totalCost || 0), 0)),
  };

  // Small turns on premium models: factual "what Haiku/mini would have cost".
  const PREMIUM = /fable|opus|mythos|gpt-5\.\d($|\s)/i;
  const smallPremium = perTurnEvents.filter(e =>
    PREMIUM.test(e.model || '')
    && (e.inputTokens || 0) < 2000
    && (e.outputTokens || 0) < 400
    && (e.cachedTokens || 0) + (e.cacheCreationTokens || 0) < 20000);
  if (smallPremium.length > 0) {
    const actual = smallPremium.reduce((s, e) => s + (e.totalCost || 0), 0);
    let cheaper = 0;
    for (const e of smallPremium) {
      const alt = e.provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-5.4-mini';
      const cost = priceCall(alt, e.inputTokens || 0, e.outputTokens || 0, e.cachedTokens || 0,
        e.cacheCreationTokens || 0, { cachedIncludedInInput: e.provider !== 'anthropic' });
      cheaper += cost.totalCost;
    }
    insights.smallTurnsOnPremiumModels = {
      turns: smallPremium.length,
      actualCost: round2(actual),
      onCheapestTierCost: round2(cheaper),
    };
  }

  return insights;
}

function printReport(report) {
  const money = (n) => `$${n.toFixed(2)}`;
  const rowCost = (row) => {
    const priced = `${money(row.cost)} · ${row.calls} calls`;
    return row.roughEstimateCost > 0
      ? `${priced} · rough ~${money(row.roughEstimateCost)} excluded (${row.unpricedCalls} unpriced)`
      : priced;
  };
  const line = (label, value) => {
    const name = label.length > 25 ? `${label.slice(0, 24)}…` : label;
    console.log(`  ${name.padEnd(26)}${value}`);
  };
  const section = (title) => console.log(`\n  ${title}\n  ${'─'.repeat(46)}`);

  const scopes = [
    report.toolFilter !== 'all' ? `${report.toolFilter} tool` : null,
    report.providerFilter !== 'all' ? `${providerDisplayName(report.providerFilter)} provider` : null,
  ].filter(Boolean);
  console.log(`\n  Tokimeter Report · last ${report.windowDays} days${scopes.length ? ` · ${scopes.join(' + ')}` : ''}`);
  console.log(`  ${'═'.repeat(46)}`);

  // Runaway-agent alarm surfaces at the top — a spike is the thing you'd want
  // to see first. Full breakdown in `tokimeter burn`.
  for (const a of report.burn?.alerts || []) {
    console.log(`  ⚠ Burn spike — ${a.message}`);
  }

  if (report.totals.calls === 0) {
    console.log(`  No local usage found.`);
    console.log(`  Tokimeter reads local usage metadata from supported AI coding`);
    console.log(`  tools. Run a tracked turn, then re-run the same report command.\n`);
    return;
  }

  line('Priced total', `${money(report.totals.cost)} · ${report.totals.calls} calls`);
  if (report.totals.roughEstimateCost > 0) {
    line('Unknown-model rough', `~${money(report.totals.roughEstimateCost)} · ${report.totals.unpricedCalls} calls · excluded from priced total`);
  }
  line('Today', `${money(report.today.cost)} · ${report.today.calls} calls`);
  line('Last 7 days', `${money(report.last7Days.cost)} · ${report.last7Days.calls} calls`);
  line('Tokens', `${fmtTokens(report.totals.inputTokens)} in · ${fmtTokens(report.totals.outputTokens)} out · ${fmtTokens(report.totals.cachedTokens)} cache read · ${fmtTokens(report.totals.cacheCreationTokens)} cache write`);
  if (report.totals.reasoningTokens > 0) line('Reasoning tokens', fmtTokens(report.totals.reasoningTokens));
  if (report.cacheReadSavings > 0) line('Saved by prompt caching', `~${money(report.cacheReadSavings)}`);

  section('Pricing provenance');
  for (const row of report.pricingSources) line(row.name, rowCost(row));

  section('By tool');
  for (const row of report.byTool) line(row.name, rowCost(row));

  section('By provider');
  for (const row of report.byProvider) line(row.name, rowCost(row));

  if (report.byAccessPath.length > 0) {
    section('By access path');
    for (const row of report.byAccessPath) line(row.name, rowCost(row));
  }

  section('By model');
  for (const row of report.byModel.slice(0, 10)) line(row.name, rowCost(row));

  section('By project');
  for (const row of report.byProject.slice(0, 10)) line(row.name, rowCost(row));

  if (Array.isArray(report.bySession) && report.bySession.length > 0) {
    section('By session (top 10)');
    for (const row of report.bySession) line(row.name, rowCost(row));
  }

  section('By day');
  const maxDay = Math.max(...report.byDay.map(d => d.cost), 0.01);
  for (const row of report.byDay.slice(-14)) {
    const bar = '█'.repeat(Math.max(1, Math.round((row.cost / maxDay) * 24)));
    const rough = row.roughEstimateCost > 0 ? ` · rough ~${money(row.roughEstimateCost)} excluded` : '';
    console.log(`  ${row.date}  ${bar} ${money(row.cost)}${rough}`);
  }

  const ins = report.insights || {};
  section('Insights');
  line('Cache hit rate', `${ins.cacheHitRate}% of context tokens served from cache`);
  if (Array.isArray(ins.coldCache) && ins.coldCache.length > 0) {
    console.log(`  Cold cache (writes not reused):`);
    for (const c of ins.coldCache) {
      console.log(`    ${c.project} · ${fmtTokens(c.cacheWriteTokens)} write / ${fmtTokens(c.cacheReadTokens)} read (${c.readWriteRatio}×) · ~${money(c.cacheWriteCost)} on writes`);
    }
  }
  if (ins.largeContext?.turns > 0) {
    line('Large-context turns', `${ins.largeContext.turns} turns over ${fmtTokens(ins.largeContext.threshold)} context cost ${money(ins.largeContext.cost)}`);
  }
  if (ins.smallTurnsOnPremiumModels) {
    const s = ins.smallTurnsOnPremiumModels;
    line('Small turns, big models', `${s.turns} small turns cost ${money(s.actualCost)}; same tokens on Haiku/mini: ${money(s.onCheapestTierCost)}`);
  }
  if (Array.isArray(ins.topTurns) && ins.topTurns.length > 0) {
    console.log(`  Priciest turns:`);
    for (const t of ins.topTurns) {
      console.log(`    ${localMinute(t.when)} · ${t.tool} · ${t.model} · ${fmtTokens(t.contextTokens)} ctx → ${fmtTokens(t.outputTokens)} out · ${money(t.cost)}${t.project ? ` · ${t.project}` : ''}`);
    }
  }

  console.log(`\n  Priced totals use provider/tool-reported costs or sourced API rates.`);
  console.log(`  Subscription values are API-equivalent, not invoices; unknown models stay separate.`);
  console.log(`  Live tracking + budgets: tokimeter setup --auto\n`);
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseCodexImportArgs(importArgs) {
  const backfill = importArgs.includes('--backfill');
  const limitArg = importArgs.find(arg => arg.startsWith('--limit='));
  const sinceArg = importArgs.find(arg => arg.startsWith('--since-minutes='));
  const defaultLimit = backfill ? 40 : 10;
  const defaultSinceMinutes = backfill ? 0 : 10;
  const limit = Math.max(1, parseInt(limitArg?.split('=')[1] || String(defaultLimit), 10) || defaultLimit);
  const sinceMinutes = sinceArg ? Math.max(0, parseFloat(sinceArg.split('=')[1]) || 0) : defaultSinceMinutes;

  return {
    limit,
    sinceMs: sinceMinutes > 0 ? Date.now() - sinceMinutes * 60 * 1000 : 0,
  };
}

async function importCodexRolloutTokenCounts({ verbose = false, limit = 10, sinceMs = Date.now() - 10 * 60 * 1000, onRecorded = null } = {}) {
  if (!(await ensureProxyRunning(false, true))) {
    return 0;
  }

  const files = recentCodexRolloutFiles({ limit });
  let recorded = 0;
  let duplicates = 0;
  let failed = 0;
  let scanned = 0;

  for (const file of files) {
    const events = readCodexTokenEvents(file, { sinceMs });
    scanned += events.length;
    for (const event of events) {
      const result = await postJSON(`${PROXY_URL}/api/track`, event);
      if (!result?.ok) {
        failed++;
      } else if (result.duplicate) {
        duplicates++;
      } else {
        recorded++;
        if (onRecorded) onRecorded(result.call || event);
      }
    }
  }

  if (verbose) {
    console.log(`  Codex rollout import scanned ${scanned} token events from ${files.length} recent files.`);
    console.log(`  Recorded ${recorded} new events; skipped ${duplicates} already-seen events${failed ? `; ${failed} failed` : ''}.`);
    if (sinceMs) {
      const minutes = Math.max(1, Math.round((Date.now() - sinceMs) / 60000));
      console.log(`  Window: last ${minutes} minutes. Use --backfill to intentionally import older Codex sessions.`);
    }
  }
  return recorded;
}

function parseClaudeImportArgs(importArgs) {
  const backfill = importArgs.includes('--backfill');
  const quiet = importArgs.includes('--quiet');
  const limitArg = importArgs.find(arg => arg.startsWith('--limit='));
  const sinceArg = importArgs.find(arg => arg.startsWith('--since-minutes='));
  const defaultLimit = backfill ? 80 : 12;
  const defaultSinceMinutes = backfill ? 0 : 10;
  const limit = Math.max(1, parseInt(limitArg?.split('=')[1] || String(defaultLimit), 10) || defaultLimit);
  const sinceMinutes = sinceArg ? Math.max(0, parseFloat(sinceArg.split('=')[1]) || 0) : defaultSinceMinutes;

  return {
    limit,
    quiet,
    sinceMs: sinceMinutes > 0 ? Date.now() - sinceMinutes * 60 * 1000 : 0,
  };
}

// Import Grok Build per-turn usage from ~/.grok/logs/unified.jsonl into the
// proxy store. Records are immutable per turn, so dedupe by externalId is
// safe to run repeatedly. Default window: 7 days; --backfill imports all.
async function importGrokUsage(importArgs, { quiet = false } = {}) {
  if (!existsSync(GROK_UNIFIED_LOG)) {
    if (!quiet) {
      console.error(`  No Grok Build log found at ${GROK_UNIFIED_LOG}`);
      console.error(`  Grok Build writes usage there automatically once you use the grok CLI.`);
    }
    return 0;
  }
  if (!(await ensureProxyRunning(false, true))) return 0;

  const sinceMs = importArgs.includes('--backfill') ? 0 : Date.now() - 7 * 86400 * 1000;
  const events = collectGrokUsageEvents({ sinceMs });
  let recorded = 0, duplicates = 0, failed = 0;
  for (const event of events) {
    const result = await postJSON(`${PROXY_URL}/api/track`, event);
    if (!result?.ok) failed++;
    else if (result.duplicate) duplicates++;
    else recorded++;
  }
  if (!quiet) {
    console.log(`  Grok Build import: ${events.length} turns from ${GROK_UNIFIED_LOG}`);
    console.log(`  Recorded ${recorded} new events; skipped ${duplicates} already-seen${failed ? `; ${failed} failed` : ''}.`);
  }
  return recorded;
}

// Import Hermes session totals into the proxy store. Hermes rows keep
// accumulating while a session is live, so only settled sessions import
// (ended, or started >24h ago); `tokimeter report` always reads live totals
// directly and is unaffected.
async function importHermesUsage(importArgs, { quiet = false } = {}) {
  if (!existsSync(HERMES_STATE_DB)) {
    if (!quiet) console.error(`  No Hermes state found at ${HERMES_STATE_DB}`);
    return 0;
  }
  if (!(await ensureProxyRunning(false, true))) return 0;

  const sinceMs = importArgs.includes('--backfill') ? 0 : Date.now() - 7 * 86400 * 1000;
  const settledBefore = Date.now() - 24 * 3600 * 1000;
  const allEvents = readHermesUsageEvents({ sinceMs });
  const events = allEvents.filter(e => e.ended || e.timestamp < settledBefore);
  const skippedLive = allEvents.length - events.length;

  let recorded = 0, duplicates = 0, failed = 0;
  for (const event of events) {
    if (!(Number(event.totalCost) > 0)) {
      const cost = priceCall(event.model, event.inputTokens, event.outputTokens,
        event.cachedTokens || 0, event.cacheCreationTokens || 0, { cachedIncludedInInput: false });
      event.inputCost = cost.inputCost;
      event.outputCost = cost.outputCost;
      event.totalCost = cost.totalCost;
      event.roughEstimateCost = cost.roughEstimateCost || 0;
      event.pricingConfidence = cost.pricingSource;
    }
    const result = await postJSON(`${PROXY_URL}/api/track`, event);
    if (!result?.ok) failed++;
    else if (result.duplicate) duplicates++;
    else recorded++;
  }
  if (!quiet) {
    console.log(`  Hermes import: ${events.length} settled sessions from ${HERMES_STATE_DB}`);
    console.log(`  Recorded ${recorded} new; skipped ${duplicates} already-seen${skippedLive > 0 ? `; ${skippedLive} still-active sessions deferred` : ''}${failed ? `; ${failed} failed` : ''}.`);
    console.log(`  Note: tokimeter report reads Hermes totals live — importing is only needed for the proxy dashboard/HUDs.`);
  }
  return recorded;
}

// Import usage/cost lines from an aider chat history file. Aider writes one
// per project directory, so the path is explicit (default: cwd) rather than
// discovered globally.
async function importAiderHistory(importArgs) {
  const pathArg = importArgs.find(arg => !arg.startsWith('--'));
  const filePath = resolve(pathArg || join(process.cwd(), '.aider.chat.history.md'));

  if (!existsSync(filePath)) {
    console.error(`  No aider history found at ${filePath}`);
    console.error(`  Usage: tokimeter aider-import [path/to/.aider.chat.history.md]`);
    process.exitCode = 1;
    return 0;
  }
  if (!(await ensureProxyRunning(false, true))) {
    return 0;
  }

  const events = readAiderHistoryEvents(filePath);
  let recorded = 0;
  let duplicates = 0;
  let failed = 0;
  for (const event of events) {
    const result = await postJSON(`${PROXY_URL}/api/track`, event);
    if (!result?.ok) failed++;
    else if (result.duplicate) duplicates++;
    else recorded++;
  }

  console.log(`  Aider import: ${events.length} usage lines in ${filePath}`);
  console.log(`  Recorded ${recorded} new events; skipped ${duplicates} already-seen${failed ? `; ${failed} failed` : ''}.`);
  console.log(`  Costs come from aider's own "Cost: $X message" lines when present; token counts are aider's rounded values.`);
  return recorded;
}

async function importClaudeTranscriptUsage({ verbose = false, limit = 12, sinceMs = Date.now() - 10 * 60 * 1000, onRecorded = null } = {}) {
  if (!(await ensureProxyRunning(false, true))) {
    return 0;
  }

  const files = recentClaudeTranscriptFiles({ limit });
  let recorded = 0;
  let duplicates = 0;
  let failed = 0;
  let scanned = 0;

  for (const file of files) {
    const events = readClaudeUsageEvents(file, { sinceMs });
    scanned += events.length;
    for (const event of events) {
      const result = await postJSON(`${PROXY_URL}/api/track`, event);
      if (!result?.ok) {
        failed++;
      } else if (result.duplicate) {
        duplicates++;
      } else {
        recorded++;
        if (onRecorded) onRecorded(result.call || event);
      }
    }
  }

  if (verbose) {
    console.log(`  Claude transcript import scanned ${scanned} usage events from ${files.length} recent files.`);
    console.log(`  Recorded ${recorded} new events; skipped ${duplicates} already-seen events${failed ? `; ${failed} failed` : ''}.`);
    if (sinceMs) {
      const minutes = Math.max(1, Math.round((Date.now() - sinceMs) / 60000));
      console.log(`  Window: last ${minutes} minutes. Use --backfill to intentionally import older Claude sessions.`);
    }
  }
  return recorded;
}

function recentClaudeTranscriptFiles({ limit = 12, maxAgeMs = 7 * 86400 * 1000 } = {}) {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const files = [];
  const cutoff = Date.now() - maxAgeMs;

  function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(fullPath);
          if (st.mtimeMs >= cutoff) files.push({ path: fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }

  walk(CLAUDE_PROJECTS_DIR);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(file => file.path);
}


function recentCodexRolloutFiles({ limit = 10, maxAgeMs = 7 * 86400 * 1000 } = {}) {
  return recentCodexRolloutFilesShared(CODEX_SESSIONS_DIR, { limit, maxAgeMs });
}


function summarizeCalls(calls) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const summary = {
    todayCost: 0,
    todayCalls: 0,
    totalCost: 0,
    totalCalls: 0,
    todayEstCost: 0,
    totalEstCost: 0,
    todayRoughEstimateCost: 0,
    roughEstimateCost: 0,
    roughEstimateCalls: 0,
  };

  for (const call of Array.isArray(calls) ? calls : []) {
    const cost = Number(call.totalCost) || 0;
    const rough = Math.max(0, Number(call.roughEstimateCost) || 0);
    const estimated = isEstimatedCall(call);
    summary.totalCost += cost;
    summary.totalCalls += 1;
    summary.roughEstimateCost += rough;
    if (rough > 0) summary.roughEstimateCalls += 1;
    if (estimated) summary.totalEstCost += cost;
    if ((Number(call.timestamp) || 0) >= todayMs) {
      summary.todayCost += cost;
      summary.todayCalls += 1;
      summary.todayRoughEstimateCost += rough;
      if (estimated) summary.todayEstCost += cost;
    }
  }

  return summary;
}

// Imported/local-metadata usage is an API-equivalent estimate (notional on a
// subscription); only calls proxied with a real API key are actually billed.
function isEstimatedCall(call) {
  const source = String(call?.source || '');
  return source.startsWith('claude-transcript')
    || source.startsWith('codex-rollout')
    || source.startsWith('codex-cli')
    || source === 'manual';
}

// "$1.23" when fully billed, "~$1.23" when fully estimated, split when mixed.
function formatCostWithBasis(cost, estCost) {
  const money = `$${cost.toFixed(4)}`;
  if (estCost <= 0) return money;
  if (estCost >= cost - 1e-9) return `~${money}`;
  return `${money} (incl. ~$${estCost.toFixed(4)} est)`;
}

function formatTodayModelBreakdown(calls, todayCalls) {
  if (!Array.isArray(calls) || calls.length === 0) return '';

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const groups = new Map();

  for (const call of calls) {
    if ((Number(call.timestamp) || 0) < todayMs) continue;
    const key = `${call.model || 'unknown'}${call.effort ? ` ${call.effort}` : ''}`;
    const current = groups.get(key) || { calls: 0, cost: 0, reasoningTokens: 0 };
    current.calls += 1;
    current.cost += Number(call.totalCost) || 0;
    current.reasoningTokens += Number(call.reasoningTokens) || 0;
    groups.set(key, current);
  }

  if (groups.size === 0) return '';

  const rows = [...groups.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 4)
    .map(([label, value]) => {
      const reasoning = value.reasoningTokens ? `, ${value.reasoningTokens.toLocaleString()} reasoning` : '';
      return `${value.calls}x ${label} $${value.cost.toFixed(4)}${reasoning}`;
    });

  const covered = [...groups.values()].reduce((sum, value) => sum + value.calls, 0);
  const scope = todayCalls > covered ? `recent ${covered}/${todayCalls}` : `${covered}`;
  return `${rows.join(' · ')} (${scope} today)`;
}

function formatTodaySessionBreakdown(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return '';

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const groups = new Map();

  for (const call of calls) {
    if ((Number(call.timestamp) || 0) < todayMs) continue;
    const context = formatCallContext(call) || 'unknown session';
    const model = `${call.model || 'unknown'}${call.effort ? ` ${call.effort}` : ''}`;
    const key = `${context} · ${model}`;
    const current = groups.get(key) || { calls: 0, cost: 0 };
    current.calls += 1;
    current.cost += Number(call.totalCost) || 0;
    groups.set(key, current);
  }

  if (groups.size <= 1) return '';

  return [...groups.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 3)
    .map(([label, value]) => `${value.calls}x ${label} $${value.cost.toFixed(4)}`)
    .join(' · ');
}

function formatCallContext(call) {
  if (!call?.cwd) return '';
  return shortenPath(String(call.cwd));
}

function shortenPath(pathValue) {
  const home = homedir();
  let value = pathValue === home
    ? '~'
    : pathValue.startsWith(`${home}/`)
      ? `~/${pathValue.slice(home.length + 1)}`
      : pathValue;

  const parts = value.split('/').filter(Boolean);
  if (value.startsWith('~/') && parts.length > 3) {
    value = `~/${parts.slice(-2).join('/')}`;
  } else if (!value.startsWith('~') && parts.length > 3) {
    value = `.../${parts.slice(-2).join('/')}`;
  }

  return value;
}

function formatCallLabels(call) {
  const confidence = call?.confidence || confidenceForSource(call?.source);
  const pricingConfidence = call?.pricingConfidence || getPricingSource(call?.model || '').confidence;
  const labels = [tokenConfidenceLabel(confidence)];
  labels.push(pricingConfidenceLabel(pricingConfidence));
  return labels.join('/');
}

function tokenConfidenceLabel(confidence) {
  if (confidence === 'exact') return 'exact tokens';
  if (confidence === 'estimated') return 'estimated tokens';
  if (confidence === 'imported') return 'imported tokens';
  if (confidence === 'manual') return 'manual tokens';
  if (confidence === 'local-hint' || confidence === 'local-pre-submit') return 'local hint';
  return 'tracked tokens';
}

function pricingConfidenceLabel(confidence) {
  if (confidence === 'custom') return 'custom pricing';
  if (confidence === 'community' || confidence === 'feed') return 'community pricing';
  if (confidence === 'reported') return 'reported cost';
  if (confidence === 'fallback') return 'unpriced';
  return 'verified built-in pricing';
}

function formatCallCost(call) {
  const rough = Math.max(0, Number(call?.roughEstimateCost) || 0);
  if (rough > 0) return `rough ~$${rough.toFixed(4)} excluded`;
  return `$${(Number(call?.totalCost) || 0).toFixed(4)}`;
}

function confidenceForSource(source) {
  if (source === 'codex-rollout-token-count') return 'imported';
  if (source === 'codex-cli-summary') return 'estimated';
  if (source === 'manual') return 'manual';
  return 'tracked';
}

async function fetchSessionUsageForTool(toolName, startedAt, { fallbackCost = 0, fallbackCalls = 0 } = {}) {
  const calls = await fetchRecentCalls(200);
  const sessionCalls = calls.filter(call => isSessionCallForTool(call, toolName, startedAt));

  if (sessionCalls.length > 0) {
    return {
      calls: sessionCalls.length,
      cost: sessionCalls.reduce((sum, call) => sum + (Number(call.totalCost) || 0), 0),
    };
  }

  if (shouldUseGlobalSessionFallback(toolName)) {
    return {
      calls: Math.max(0, Number(fallbackCalls) || 0),
      cost: Math.max(0, Number(fallbackCost) || 0),
    };
  }

  return { calls: 0, cost: 0 };
}

function isSessionCallForTool(call, toolName, startedAt) {
  if (!call || (Number(call.timestamp) || 0) < startedAt - 5000) return false;
  return callMatchesTool(call, toolName);
}

function callMatchesTool(call, toolName) {
  if (!call) return false;
  const callTool = String(call.tool || '');
  const provider = String(call.provider || '');
  const source = String(call.source || '');

  // Provider-based fallbacks only apply when the call has no explicit tool —
  // otherwise Hermes/Grok sessions on anthropic/openai models would leak
  // into the claude/openai filters.
  const untagged = !callTool || callTool === 'unknown';
  if (toolName === 'claude') {
    return callTool === 'claude-code' || (provider === 'anthropic' && untagged);
  }
  if (toolName === 'codex' || toolName === 'codex-api' || toolName === 'codex-chatgpt') {
    return callTool === 'codex' || source.startsWith('codex-');
  }
  if (toolName === 'aider') return callTool === 'aider';
  if (toolName === 'openai') return callTool === 'openai' || (provider === 'openai' && untagged);
  return callTool === toolName;
}

function parseToolFilter(cmdArgs) {
  const eqArg = cmdArgs.find(arg => arg.startsWith('--tool='));
  if (eqArg) return normalizeToolFilter(eqArg.split('=')[1]);
  const flagIndex = cmdArgs.indexOf('--tool');
  if (flagIndex !== -1) return normalizeToolFilter(cmdArgs[flagIndex + 1]);
  return null;
}

function parseProviderFilter(cmdArgs) {
  const eqArg = cmdArgs.find(arg => arg.startsWith('--provider='));
  if (eqArg) return normalizeProviderFilter(eqArg.split('=')[1]);
  const flagIndex = cmdArgs.indexOf('--provider');
  if (flagIndex !== -1) return normalizeProviderFilter(cmdArgs[flagIndex + 1]);
  return null;
}

function normalizeProviderFilter(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return null;
  if (provider === 'x.ai' || provider === 'grok') return 'xai';
  if (provider === 'claude') return 'anthropic';
  if (provider === 'gemini') return 'google';
  return provider;
}

function providerDisplayName(value) {
  const provider = normalizeProviderFilter(value) || 'unknown';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'venice') return 'Venice';
  return provider;
}

function normalizeToolFilter(value) {
  const tool = String(value || '').trim().toLowerCase();
  if (!tool) return null;
  if (tool === 'claude-code' || tool === 'anthropic') return 'claude';
  if (tool === 'codex-api' || tool === 'codex-chatgpt' || tool === 'openai-codex') return 'codex';
  return tool;
}

function shouldUseGlobalSessionFallback(toolName) {
  return !['claude', 'codex', 'codex-api', 'codex-chatgpt'].includes(toolName);
}

async function checkProxyHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${PROXY_URL}/health`, { timeout: 1000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function checkManualTrackingSupport() {
  const health = await fetchJSON(`${PROXY_URL}/api/health`);
  return health?.manualTracking === true;
}

async function checkCallMetadataSupport() {
  const health = await fetchJSON(`${PROXY_URL}/api/health`);
  return health?.callMetadata === true;
}

async function fetchSummary() {
  return fetchJSON(`${PROXY_URL}/api/summary`);
}

async function fetchTips() {
  const data = await fetchJSON(`${PROXY_URL}/api/tips`);
  return data?.tips || [];
}

async function fetchRecentCalls(limit = 10) {
  return (await fetchJSON(`${PROXY_URL}/api/calls?limit=${limit}`)) || [];
}

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
  💰 Tokimeter CLI Wrapper

  Usage:
    tokimeter <tool> [args...]   Run a CLI tool with cost tracking
    tm <tool> [args...]          Short alias for tokimeter
    tokimeter start              Start the proxy server (foreground)
    tokimeter stop               Stop the background proxy
    tokimeter status             Show proxy status and cost summary
    tokimeter report             Zero-setup usage report from local logs (no proxy needed)
    tokimeter report --days=7 --tool claude --json
    tokimeter report --tool opencode     Scope to one tool (also: claude, codex, grok, hermes, cline, copilot, cursor)
    tokimeter report --provider xai      Roll up one provider across tools (for example Grok Build + Hermes xAI OAuth)
    tokimeter export --days=30 > usage.json   JSON export (loadable by the Pro dashboard)
    tokimeter report --md > report.md         Shareable Markdown report (also --html)
    tokimeter agents             Director vs subagent-worker cost split (delegation report)
    tokimeter burn               Runaway-agent alarm: burn-rate spikes vs your own baseline
    tokimeter savings            Where routine premium-model turns could shift cheaper (factual)
    tokimeter savings --emit-policy[=litellm|openrouter]   Routing policy from your real usage, for your gateway
    tokimeter report --orchestration   Add cross-tool "used together" windows to the report
    tokimeter limits             5h rolling window + weekly usage vs your budgets
    tokimeter plan               Headroom left in each window + time-to-limit at your current pace
    tokimeter compare            Model comparison on your actual workload
    tokimeter trace <session>    One session explained: cost, models, delegation, cache
    tokimeter card               "My month in AI" shareable SVG card (local file; --month=YYYY-MM, --json, --stdout, --out=path)
    tokimeter watch              Quiet local spend/model change feed
    tokimeter watch --tool claude|codex  Same feed scoped to one tool
    tokimeter latest             Show latest tracked calls (add --tool claude|codex)
    tokimeter pricing list       List built-in, community, and custom pricing
    tokimeter pricing source ... Explain pricing source for a model
    tokimeter config list        Show local Tokimeter settings
    tokimeter codex-import       Import recent Codex rollout token metadata
    tokimeter claude-import      Import recent Claude Code transcript usage
    tokimeter aider-import [path] Import usage/cost lines from an aider chat history
    tokimeter grok-import        Import Grok Build per-turn usage (~/.grok logs)\n    tokimeter cursor-import <csv> Import a cursor.com dashboard usage export (desktop chat coverage)
    tokimeter hermes-import      Import settled Hermes session totals (~/.hermes)
    tokimeter connect <code>     Connect this installation from tokimeter.com/app
    tokimeter sync [--days=30]   Sync all supported tools now (metadata only)
    tokimeter login <url> <key>  Advanced: connect with an ingest URL + device key
    tokimeter logout             Disable sync and remove the stored device key
    tokimeter setup --auto       One-command local install for Codex + Claude
    tokimeter setup [tool]       Configure a specific local tool profile
    tokimeter setup --dry-run    Print exact setup files/actions; change nothing
    tokimeter setup cursor       Cursor CLI: Tokimeter status line + exact per-turn usage capture (hook)
    tokimeter setup grok         Grok Build: desktop budget alarm on turn end (Stop hook)
    tokimeter setup [tool] --auto Install shims for a specific tool
    tokimeter uninstall          Restore prior configs and remove generated setup files
    tokimeter doctor             Diagnose local setup\n    tokimeter repair             Restart proxy, regenerate shims/HUD, refresh pricing
    tokimeter ready              Simple "can I use codex/claude now?" check

  Supported tools:
    tokimeter claude "prompt"      Claude Code CLI
    tokimeter codex "prompt"       Codex CLI (auto: API key if present, otherwise ChatGPT login)
    tokimeter codex-api "prompt"   Codex CLI using OPENAI_API_KEY
    tokimeter codex-chatgpt "..."  Codex CLI using your Codex/ChatGPT login
    tokimeter aider [args]         Aider (OpenAI-provider models)

  Examples:
    tokimeter claude "refactor auth.py"
    tokimeter codex "fix the bug in utils.js"
    tm codex-chatgpt exec --skip-git-repo-check "say hello"
    tokimeter setup --auto
    tokimeter uninstall
    tm ready
    tm doctor
    tm watch --once
    tm watch --live
    tm watch --debug
    tm watch --once --tool claude
    tm latest --tool codex
    tm pricing source claude-sonnet-5
    tm config set claude.advisorModel haiku
    tm codex-import --backfill
    tm claude-import --backfill
    tm aider --message "add tests for user.py"

  Auto setup installs shims in ~/.tokimeter/bin so normal codex/claude
  terminal commands route through Tokimeter after your shell PATH reloads.
  Use tokimeter watch for diagnostics; inline CLI/editor surfaces are the primary UX.
  `);
}
