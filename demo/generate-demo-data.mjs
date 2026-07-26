#!/usr/bin/env node
// Generates a fully synthetic demo home for the README gif so the recording
// never touches real usage data, project names, or budgets.
//
//   node demo/generate-demo-data.mjs   # writes demo/home/ (gitignored)
//   vhs demo.tape                      # records against it
//
// Timestamps are relative to "now" so reports always show a live-looking
// last-7-days window.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = join(dirname(fileURLToPath(import.meta.url)), 'home');
rmSync(HOME, { recursive: true, force: true });

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const H = 3600 * 1000, D = 24 * H;

// Deterministic pseudo-randomness so the gif is reproducible.
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const between = (lo, hi) => Math.floor(lo + rand() * (hi - lo));

// ─── Claude Code transcripts ─────────────────────────────────────────────────
const claudeProjects = join(HOME, '.claude', 'projects');
for (const [dirName, cwd, turns] of [
  ['-Users-demo-work-api', '/Users/demo/work/api', 42],
  ['-Users-demo-work-webapp', '/Users/demo/work/webapp', 18],
]) {
  const dir = join(claudeProjects, dirName);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i++) {
    // Bias the newest third of api-project turns into the last 4h so the 5h
    // window (and its budget warning) has something to show.
    const recent = dirName.endsWith('api') && i >= turns - 14;
    const msAgo = recent ? between(10 * 60 * 1000, 4 * H) : between(4 * H, 6.5 * D);
    const haiku = rand() < 0.15;
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: iso(msAgo),
      cwd,
      sessionId: `demo-${dirName}-${Math.floor(i / 8)}`,
      message: {
        id: `msg_demo_${dirName}_${i}`,
        model: haiku ? 'claude-haiku-4-5' : 'claude-fable-5',
        role: 'assistant',
        usage: {
          input_tokens: between(5, 400),
          cache_creation_input_tokens: between(0, 20000),
          cache_read_input_tokens: between(20000, 220000),
          output_tokens: between(80, 2200),
        },
      },
    }));
  }
  writeFileSync(join(dir, 'demo-session.jsonl'), lines.join('\n') + '\n');
}

// ─── Codex rollouts (incl. vendor rate-limit snapshot) ──────────────────────
const codexDir = join(HOME, '.codex', 'sessions', '2026', 'demo');
mkdirSync(codexDir, { recursive: true });
const codexLines = [
  JSON.stringify({ type: 'session_meta', timestamp: iso(6 * D), payload: { session_id: 'demo-codex', cwd: '/Users/demo/work/api' } }),
  JSON.stringify({ type: 'turn_context', timestamp: iso(6 * D), payload: { model: 'gpt-5.5', effort: 'high', cwd: '/Users/demo/work/api' } }),
];
for (let i = 0; i < 60; i++) {
  // Bias the newest dozen turns into the last 4h so the 5h window has data.
  const msAgo = i >= 48 ? between(5 * 60 * 1000, 4 * H) : between(4 * H, 6 * D);
  const input = between(4000, 90000);
  codexLines.push(JSON.stringify({
    type: 'event_msg',
    timestamp: iso(msAgo),
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: Math.floor(input * 0.8),
          output_tokens: between(100, 1800),
          reasoning_output_tokens: between(0, 400),
        },
      },
    },
  }));
}
// Newest event carries the vendor rate-limit snapshot the limits command
// surfaces (same shape Codex writes); must be fresh (<24h) to display.
codexLines.push(JSON.stringify({
  type: 'event_msg',
  timestamp: iso(4 * 60 * 1000),
  payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: 12000, cached_input_tokens: 9600, output_tokens: 400, reasoning_output_tokens: 50 } },
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 48, window_minutes: 300, resets_at: Math.floor((now + 69 * 60 * 1000) / 1000) },
      secondary: { used_percent: 73, window_minutes: 10080, resets_at: Math.floor((now + 4.7 * D) / 1000) },
      plan_type: 'plus',
    },
  },
}));
writeFileSync(join(codexDir, 'rollout-demo.jsonl'), codexLines.join('\n') + '\n');

// ─── Grok Build unified log + session summary ────────────────────────────────
const grokSession = join(HOME, '.grok', 'sessions', '%2FUsers%2Fdemo%2Fwork%2Fapi', 'demo-grok-session');
mkdirSync(grokSession, { recursive: true });
mkdirSync(join(HOME, '.grok', 'logs'), { recursive: true });
writeFileSync(join(grokSession, 'summary.json'), JSON.stringify({
  info: { id: 'demo-grok-session', cwd: '/Users/demo/work/api' },
  current_model_id: 'grok-composer-2.5-fast',
}) + '\n');
const grokLines = [];
for (let i = 0; i < 12; i++) {
  const input = between(8000, 60000);
  grokLines.push(JSON.stringify({
    ts: iso(between(0, 5 * D)),
    src: 'shell', pid: 1, lvl: 'info', sid: 'demo-grok-session',
    msg: 'shell.turn.inference_done',
    ctx: {
      prompt_tokens: input,
      cached_prompt_tokens: Math.floor(input * 0.7),
      completion_tokens: between(120, 1500),
      reasoning_tokens: 0,
      model_elapsed_ms: between(1500, 9000),
    },
  }));
}
writeFileSync(join(HOME, '.grok', 'logs', 'unified.jsonl'), grokLines.join('\n') + '\n');

// ─── Hermes state.db ─────────────────────────────────────────────────────────
mkdirSync(join(HOME, '.hermes'), { recursive: true });
const dbPath = join(HOME, '.hermes', 'state.db');
const rows = [];
for (let i = 0; i < 9; i++) {
  const startedAgo = between(2 * H, 6 * D);
  const glm = i % 3 !== 0;
  rows.push(`INSERT INTO sessions VALUES ('demo-hermes-${i}', '${glm ? 'tui' : 'api_server'}',
    '${glm ? 'glm-5.2' : 'gemini-3.5-flash'}', ${between(8000, 300000)}, ${between(2000, 40000)},
    ${between(100000, 3000000)}, 0, ${between(0, 15000)}, 0, '${glm ? 'zai' : 'custom'}',
    '/Users/demo/work/api', ${(now - startedAgo) / 1000}, ${(now - startedAgo + H) / 1000});`);
}
execFileSync('sqlite3', [dbPath, `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, actual_cost_usd REAL,
  billing_provider TEXT, cwd TEXT, started_at REAL, ended_at REAL);
${rows.join('\n')}
`]);

// ─── Tokimeter data dir (isolated settings; budget makes the ⚠ show) ────────
mkdirSync(join(HOME, '.tokimeter'), { recursive: true });
writeFileSync(join(HOME, '.tokimeter', 'settings.json'), JSON.stringify({
  budget: { claude5h: '4', daily: '120' },
}, null, 2) + '\n');

console.log(`Demo home written to ${HOME}`);
console.log(`Record with: vhs demo.tape   (from the repo root)`);
if (!existsSync(dbPath)) console.error('warning: hermes db missing — is sqlite3 installed?');
