import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  readClaudeUsageEvents,
  readCodexTokenEvents,
  readCodexRateLimitSnapshots,
  readCopilotOtelEvents,
  readAiderHistoryEvents,
  readGrokUsageEvents,
  readGrokSessionMeta,
  analyzeLogFileFormat,
  buildHermesSessionQuery,
  hermesRowsToEvents,
  readClaudeAgentActivity,
  buildDelegationReport,
  buildAgentBreakdown,
  buildOrchestrationReport,
  buildBurnReport,
  buildBurnPlanner,
  buildSavingsReport,
  buildRoutingPolicy,
  formatRoutingPolicy,
  renderReportMarkdown,
  renderReportHtml,
  buildSessionTrace,
  buildMonthCard,
  opencodeMessageToEvent,
  readOpencodeMessageFile,
  opencodeRowsToEvents,
  clineTaskToEvents,
  readClineTaskEvents,
  clineSessionMessagesToEvents,
  readClineSessionEvents,
  copilotOtelTextToEvents,
  renderMonthCardSvg,
  cursorStopPayloadToRecord,
  readCursorUsageEvents,
  parseCursorUsageCsv,
} from '../packages/proxy/src/parsers.js';
import { priceCall } from '../packages/core/src/pricing.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLAUDE_FIXTURE = join(FIXTURES, 'claude-transcript.jsonl');
const CODEX_FIXTURE = join(FIXTURES, 'codex-rollout.jsonl');
const CLAUDE_EDGE_FIXTURE = join(FIXTURES, 'claude-edge.jsonl');
const CODEX_EDGE_FIXTURE = join(FIXTURES, 'codex-edge.jsonl');
const COPILOT_FIXTURE = join(FIXTURES, 'copilot-rollout.jsonl');

const TMP = mkdtempSync(join(tmpdir(), 'tokimeter-parsers-'));
function tmpFile(name, contents) {
  const path = join(TMP, name);
  writeFileSync(path, contents);
  return path;
}

test('claude transcript: parses usage events with all four token buckets', () => {
  const events = readClaudeUsageEvents(CLAUDE_FIXTURE);
  // msg_001 (deduped), msg_002, msg_004 (error), msg_old — zero-usage msg_003 skipped
  assert.equal(events.length, 4);

  const first = events[0];
  assert.equal(first.model, 'claude-fable-5');
  assert.equal(first.inputTokens, 120);
  assert.equal(first.cacheCreationTokens, 4000);
  assert.equal(first.cachedTokens, 30000);
  assert.equal(first.outputTokens, 450);
  assert.equal(first.provider, 'anthropic');
  assert.equal(first.tool, 'claude-code');
  assert.equal(first.source, 'claude-transcript-usage');
  assert.equal(first.confidence, 'exact');
  assert.equal(first.cwd, '/Users/dev/myproject');
  assert.equal(first.sessionId, 'abc-123');
  assert.equal(first.externalId, 'claude-transcript:msg_001');
  assert.equal(first.timestamp, Date.parse('2026-07-08T10:00:05.000Z'));
});

test('claude transcript: dedupes repeated message ids within a file', () => {
  const events = readClaudeUsageEvents(CLAUDE_FIXTURE);
  const ids = events.map(e => e.externalId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter(id => id === 'claude-transcript:msg_001').length, 1);
});

test('claude transcript: marks API-error messages as unsuccessful', () => {
  const events = readClaudeUsageEvents(CLAUDE_FIXTURE);
  const errored = events.find(e => e.externalId === 'claude-transcript:msg_004');
  assert.equal(errored.success, false);
});

test('claude transcript: skips zero-usage events and respects sinceMs', () => {
  const all = readClaudeUsageEvents(CLAUDE_FIXTURE);
  assert.equal(all.find(e => e.externalId === 'claude-transcript:msg_003'), undefined);

  const recent = readClaudeUsageEvents(CLAUDE_FIXTURE, { sinceMs: Date.parse('2026-07-05T00:00:00Z') });
  assert.equal(recent.find(e => e.externalId === 'claude-transcript:msg_old'), undefined);
  assert.equal(recent.length, 3);
});

test('claude transcript: unreadable file returns empty list', () => {
  assert.deepEqual(readClaudeUsageEvents(join(FIXTURES, 'does-not-exist.jsonl')), []);
});

test('codex rollout: parses token counts with turn context', () => {
  const events = readCodexTokenEvents(CODEX_FIXTURE);
  // 2 non-zero token_count events; zero-usage and non-token events skipped
  assert.equal(events.length, 2);

  const first = events[0];
  assert.equal(first.model, 'gpt-5.5');
  assert.equal(first.effort, 'high');
  assert.equal(first.inputTokens, 15000);
  assert.equal(first.cachedTokens, 12000);
  assert.equal(first.outputTokens, 800);
  assert.equal(first.reasoningTokens, 300);
  assert.equal(first.provider, 'openai');
  assert.equal(first.tool, 'codex');
  assert.equal(first.cwd, '/Users/dev/myproject');

  const second = events[1];
  assert.equal(second.model, 'gpt-5.4-mini');
  assert.equal(second.effort, 'low');
  assert.equal(second.inputTokens, 500);
});

test('codex rollout: externalIds are unique per line', () => {
  const events = readCodexTokenEvents(CODEX_FIXTURE);
  const ids = events.map(e => e.externalId);
  assert.equal(new Set(ids).size, ids.length);
});

test('copilot rollout: parses usage spans', () => {
  const events = readCopilotOtelEvents(COPILOT_FIXTURE);

  assert.equal(events.length, 2);

  const first = events[0];

  assert.equal(first.provider, 'github');
  assert.equal(first.tool, 'copilot');
  assert.equal(first.source, 'copilot-otel');
  assert.equal(first.confidence, 'exact');

  assert.equal(first.model, 'gpt-5.5');

  assert.equal(first.inputTokens, 1200);
  assert.equal(first.cachedTokens, 300);
  assert.equal(first.outputTokens, 120);
  assert.equal(first.reasoningTokens, 40);

  assert.equal(first.sessionId, 'conversation-1');
});

test('copilot rollout: invoke_agent is shadowed by chat', () => {
  const events = readCopilotOtelEvents(COPILOT_FIXTURE);

  assert.equal(events.length, 2);

  const ids = events.map(e => e.externalId);

  assert.equal(new Set(ids).size, ids.length);
});

test('copilot rollout: models and sessions are preserved', () => {
  const events = readCopilotOtelEvents(COPILOT_FIXTURE);

  assert.equal(events[0].model, 'gpt-5.5');
  assert.equal(events[1].model, 'gpt-5.4-mini');

  assert.equal(events[0].sessionId, 'conversation-1');
  assert.equal(events[1].sessionId, 'conversation-2');
});

test('copilot rollout: respects sinceMs', () => {
  const events = readCopilotOtelEvents(
    COPILOT_FIXTURE,
    {
      sinceMs: Date.parse('2026-07-08T11:01:00.000Z'),
    },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'gpt-5.4-mini');
});

test('claude edge fixture: survives nulls, scalars, missing fields, partial writes', () => {
  const events = readClaudeUsageEvents(CLAUDE_EDGE_FIXTURE);
  const ids = events.map(e => e.externalId.replace('claude-transcript:', ''));

  // Structural junk, missing/null usage, synthetic model, truncated tail all skipped.
  assert.ok(!ids.includes('msg_no_usage'));
  assert.ok(!ids.includes('msg_null_usage'));
  assert.ok(!ids.includes('msg_synthetic'));
  assert.ok(!ids.includes('msg_trunc'));

  // String-number usage fields still parse.
  const strings = events.find(e => e.externalId.endsWith('msg_string_numbers'));
  assert.equal(strings.inputTokens, 120);
  assert.equal(strings.cacheCreationTokens, 4000);
  assert.equal(strings.cachedTokens, 30000);
  assert.equal(strings.outputTokens, 450);

  // Nested cache_creation buckets are summed when the flat field is absent.
  const nested = events.find(e => e.externalId.endsWith('msg_nested_cache'));
  assert.equal(nested.cacheCreationTokens, 35516);

  // Negative token counts clamp to zero.
  const negative = events.find(e => e.externalId.endsWith('msg_negative'));
  assert.equal(negative.inputTokens, 0);
  assert.equal(negative.outputTokens, 40);

  // Unparseable timestamps fall back rather than crash.
  assert.ok(events.find(e => e.externalId.endsWith('msg_bad_ts')));
});

test('codex edge fixture: session_meta cwd fallback and payload drift tolerance', () => {
  const events = readCodexTokenEvents(CODEX_EDGE_FIXTURE);
  assert.equal(events.length, 2);

  // Before the first turn_context, cwd comes from session_meta.
  assert.equal(events[0].cwd, '/Users/dev/meta-project');
  assert.equal(events[0].inputTokens, 100);

  // After turn_context, its model/effort/cwd win; string numbers parse.
  assert.equal(events[1].cwd, '/Users/dev/turn-project');
  assert.equal(events[1].model, 'gpt-5.5');
  assert.equal(events[1].effort, 'medium');
  assert.equal(events[1].inputTokens, 2000);
  assert.equal(events[1].cachedTokens, 1500);
});

test('codex edge fixture: rate-limit snapshots expose 5h/7d windows', () => {
  const snapshots = readCodexRateLimitSnapshots(CODEX_EDGE_FIXTURE);
  assert.equal(snapshots.length, 2);
  const last = snapshots[snapshots.length - 1];
  assert.equal(last.planType, 'plus');
  assert.equal(last.primary.windowMinutes, 300);
  assert.equal(last.primary.usedPercent, 5.5);
  assert.equal(last.secondary.windowMinutes, 10080);
  assert.equal(last.secondary.usedPercent, 57);
  assert.equal(last.secondary.resetsAtMs, 1783889187000);
});

test('parsers: huge lines, non-UTF8 bytes, and binary junk never crash', () => {
  const hugeUsage = { input_tokens: 42, output_tokens: 7 };
  const hugeContent = 'x'.repeat(5 * 1024 * 1024);
  const hugeLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-08T10:00:00.000Z',
    message: { id: 'msg_huge', model: 'claude-fable-5', content: hugeContent, usage: hugeUsage },
  });
  const hugePath = tmpFile('huge.jsonl', hugeLine + '\n');
  const hugeEvents = readClaudeUsageEvents(hugePath);
  assert.equal(hugeEvents.length, 1);
  assert.equal(hugeEvents[0].inputTokens, 42);

  const binary = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
    Buffer.from('\n{"type":"assistant","timestamp":"2026-07-08T10:00:00.000Z","message":{"id":"msg_after_binary","model":"claude-fable-5","usage":{"input_tokens":5,"output_tokens":5}}}\n'),
    Buffer.from([0x00, 0x01, 0x02]),
  ]);
  const binaryPath = tmpFile('binary.jsonl', binary);
  const binaryEvents = readClaudeUsageEvents(binaryPath);
  assert.equal(binaryEvents.length, 1);
  assert.equal(binaryEvents[0].externalId, 'claude-transcript:msg_after_binary');

  assert.deepEqual(readCodexTokenEvents(binaryPath), []);
  assert.deepEqual(readCodexRateLimitSnapshots(binaryPath), []);
});

test('parsers: BOM-prefixed lines still parse', () => {
  const path = tmpFile('bom.jsonl', '﻿{"type":"assistant","timestamp":"2026-07-08T10:00:00.000Z","message":{"id":"msg_bom","model":"claude-fable-5","usage":{"input_tokens":1,"output_tokens":1}}}\n');
  const events = readClaudeUsageEvents(path);
  assert.equal(events.length, 1);
});

test('analyzeLogFileFormat: recognizes healthy fixtures', () => {
  for (const [file, kind] of [
    [CLAUDE_FIXTURE, 'claude'],
    [CLAUDE_EDGE_FIXTURE, 'claude'],
    [CODEX_FIXTURE, 'codex'],
    [CODEX_EDGE_FIXTURE, 'codex'],
  ]) {
    const result = analyzeLogFileFormat(file, kind);
    assert.equal(result.ok, true, `${file} should be recognized: ${result.reason}`);
    assert.ok(result.usageExtracted > 0, `${file} should yield usage`);
  }
  // The edge fixtures end mid-line: that is a partial write, not drift.
  assert.equal(analyzeLogFileFormat(CLAUDE_EDGE_FIXTURE, 'claude').truncatedTail, true);
});

test('analyzeLogFileFormat: flags renamed usage fields as unrecognized', () => {
  const drifted = tmpFile('drift.jsonl', [
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-08T10:00:00.000Z', message: { id: 'm1', model: 'claude-fable-5', usage: { promptTokens: 100, completionTokens: 50 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-08T10:01:00.000Z', message: { id: 'm2', model: 'claude-fable-5', usage: { promptTokens: 200, completionTokens: 80 } } }),
  ].join('\n') + '\n');
  const result = analyzeLogFileFormat(drifted, 'claude');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in a recognized shape/);

  const codexDrift = tmpFile('codex-drift.jsonl', JSON.stringify({
    type: 'event_msg', timestamp: '2026-07-08T11:00:00.000Z',
    payload: { type: 'token_count', info: { last_token_usage: { prompt_tokens: 900, completion_tokens: 40 } } },
  }) + '\n');
  const codexResult = analyzeLogFileFormat(codexDrift, 'codex');
  assert.equal(codexResult.ok, false);
});

test('analyzeLogFileFormat: flags mostly-binary files, tolerates trailing partial write', () => {
  const garbage = tmpFile('garbage.jsonl', 'not json\nstill not json\n \nnope\n');
  assert.equal(analyzeLogFileFormat(garbage, 'claude').ok, false);

  const partial = tmpFile('partial.jsonl',
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-08T10:00:00.000Z', message: { id: 'm1', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 } } })
    + '\n{"type":"assistant","message":{"id":"m2","usa');
  const result = analyzeLogFileFormat(partial, 'claude');
  assert.equal(result.ok, true);
  assert.equal(result.truncatedTail, true);
});

test('aider history: parses token/cost lines with model and session context', () => {
  const AIDER_FIXTURE = join(FIXTURES, 'aider-history.md');
  const events = readAiderHistoryEvents(AIDER_FIXTURE);
  // 3 usage lines with nonzero tokens; the zero-usage line is skipped and
  // prose mentioning "Tokens:" mid-paragraph never matches.
  assert.equal(events.length, 3);

  const first = events[0];
  assert.equal(first.model, 'gpt-5.5');
  assert.equal(first.provider, 'openai');
  assert.equal(first.tool, 'aider');
  assert.equal(first.inputTokens, 2800);
  assert.equal(first.outputTokens, 27);
  assert.equal(first.totalCost, 0.0029);
  assert.equal(first.confidence, 'estimated');
  assert.ok(first.timestamp >= Date.parse('2026-07-08T09:00:00'));

  const second = events[1];
  assert.equal(second.inputTokens, 12000);
  assert.equal(second.outputTokens, 1200);
  assert.equal(second.totalCost, 0.0338);
  assert.equal(second.sessionId, events[0].sessionId);

  // Second session: Model: (older format) applies, no cost line → totalCost
  // absent so downstream pricing fills it in.
  const third = events[2];
  assert.equal(third.model, 'claude-sonnet-5');
  assert.equal(third.provider, 'anthropic');
  assert.equal(third.inputTokens, 500);
  assert.equal(third.outputTokens, 100);
  assert.equal(third.totalCost, undefined);
  assert.notEqual(third.sessionId, events[0].sessionId);

  const ids = events.map(e => e.externalId);
  assert.equal(new Set(ids).size, ids.length);
});

test('grok unified log: parses inference_done turns with session meta enrichment', () => {
  const GROK_FIXTURE = join(FIXTURES, 'grok-unified.jsonl');
  const sessionMeta = {
    'sess-aaa': { model: 'grok-composer-2.5-fast', cwd: '/Users/dev/proj' },
    'sess-bbb': { model: 'grok-build', cwd: '/Users/dev/other' },
  };
  const events = readGrokUsageEvents(GROK_FIXTURE, { sessionMeta });
  // 5 inference_done lines minus 1 zero-usage = 4 events (incl. the sid-less one)
  assert.equal(events.length, 4);

  const first = events[0];
  assert.equal(first.model, 'grok-composer-2.5-fast');
  assert.equal(first.provider, 'xai');
  assert.equal(first.tool, 'grok');
  assert.equal(first.inputTokens, 14332);
  assert.equal(first.cachedTokens, 11274);
  assert.equal(first.outputTokens, 156);
  assert.equal(first.cwd, '/Users/dev/proj');
  assert.equal(first.sessionId, 'sess-aaa');
  assert.equal(first.latencyMs, 2947);

  assert.equal(events[1].reasoningTokens, 88);
  const other = events.find(e => e.inputTokens === 500);
  assert.equal(other.model, 'grok-build');
  assert.equal(other.cwd, '/Users/dev/other');
  // A record with no sid still imports, with the honest defaults.
  const sidless = events.find(e => e.inputTokens === 100);
  assert.equal(sidless.model, 'grok-build');
  assert.equal(sidless.sessionId, undefined);
  assert.equal(sidless.cwd, undefined);

  // Without meta, the model defaults honestly to grok-build.
  const bare = readGrokUsageEvents(GROK_FIXTURE);
  assert.ok(bare.every(e => e.model === 'grok-build'));

  const ids = events.map(e => e.externalId);
  assert.equal(new Set(ids).size, ids.length);
});

test('grok session meta: reads summary.json across encoded cwd dirs', () => {
  const root = join(TMP, 'grok-sessions');
  const sess = join(root, '%2FUsers%2Fdev%2Fproj', '0197-abc');
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, 'summary.json'), JSON.stringify({
    info: { id: '0197-abc', cwd: '/Users/dev/proj' },
    current_model_id: 'grok-composer-2.5-fast',
  }));
  const broken = join(root, '%2Ftmp', '0197-broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'summary.json'), '{truncated');

  const meta = readGrokSessionMeta(root);
  assert.deepEqual(meta['0197-abc'], { model: 'grok-composer-2.5-fast', cwd: '/Users/dev/proj' });
  assert.equal(Object.keys(meta).length, 1);

  assert.deepEqual(readGrokSessionMeta(join(TMP, 'missing-dir')), {});
});

test('aider history: unreadable file returns empty list', () => {
  assert.deepEqual(readAiderHistoryEvents(join(FIXTURES, 'missing-aider.md')), []);
});

test('pricing: anthropic disjoint buckets bill input + cache read + cache write', () => {
  // fable-5: $10 in, $1 cache read, $12.50 cache write, $50 out per 1M
  const cost = priceCall('claude-fable-5', 1000, 500, 50000, 20000, { cachedIncludedInInput: false });
  assert.ok(Math.abs(cost.inputCost - (0.01 + 0.05 + 0.25)) < 1e-9);
  assert.ok(Math.abs(cost.outputCost - 0.025) < 1e-9);
});

test('pricing: openai cached tokens are subtracted from input', () => {
  // gpt-5.5: $5 in, $0.50 cached, input inclusive of cached
  const cost = priceCall('gpt-5.5', 1_000_000, 0, 500_000);
  assert.ok(Math.abs(cost.inputCost - (0.5 * 5 + 0.5 * 0.5)) < 1e-9);
});

test('pricing: fixture events price end-to-end without fallback', () => {
  for (const event of [...readClaudeUsageEvents(CLAUDE_FIXTURE), ...readCodexTokenEvents(CODEX_FIXTURE)]) {
    assert.notEqual(event.pricingConfidence, 'fallback', `${event.model} should have built-in pricing`);
    const cost = priceCall(event.model, event.inputTokens, event.outputTokens, event.cachedTokens || 0,
      event.cacheCreationTokens || 0, { cachedIncludedInInput: event.provider !== 'anthropic' });
    assert.ok(cost.totalCost >= 0);
    assert.ok(cost.price, `${event.model} should resolve to a known price`);
  }
});

// ─── Delegation (director vs worker) attribution ─────────────────────────────

const SIDECHAIN_FIXTURE = join(FIXTURES, 'claude-sidechain.jsonl');

test('claude: sidechain turns are marked role=worker, main thread is not', () => {
  const events = readClaudeUsageEvents(SIDECHAIN_FIXTURE);
  assert.equal(events.length, 6);
  const workers = events.filter((e) => e.role === 'worker');
  assert.equal(workers.length, 3);
  assert.deepEqual(workers.map((e) => e.model).sort(),
    ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-5']);
  for (const e of events.filter((e) => e.role !== 'worker')) {
    assert.equal(e.role, undefined);
  }
});

test('hermes: subagent rows carry role=worker and parentSessionId', () => {
  const rows = [
    { id: 'h-dir', source: 'cli', model: 'glm-5.2', input_tokens: 1000, output_tokens: 400,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.5,
      billing_provider: 'zai', cwd: '/w', started_at: 1751300000, ended_at: 1751300100, parent_session_id: null },
    { id: 'h-w1', source: 'subagent', model: 'gemini-3.1-pro-preview', input_tokens: 2000, output_tokens: 900,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.2,
      billing_provider: '', cwd: '/w', started_at: 1751300010, ended_at: 1751300050, parent_session_id: 'h-dir' },
    { id: 'h-w2', source: 'subagent', model: 'gemini-3.1-pro-preview', input_tokens: 1500, output_tokens: 700,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.1,
      billing_provider: '', cwd: '/w', started_at: 1751300020, ended_at: 1751300060, parent_session_id: 'h-dir' },
    { id: 'h-solo', source: 'tui', model: 'glm-5.2', input_tokens: 500, output_tokens: 200,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.05,
      billing_provider: 'zai', cwd: '/w', started_at: 1751300200, ended_at: 1751300300, parent_session_id: null },
  ];
  const events = hermesRowsToEvents(rows);
  assert.equal(events.length, 4);
  const workers = events.filter((e) => e.role === 'worker');
  assert.equal(workers.length, 2);
  assert.ok(workers.every((e) => e.parentSessionId === 'h-dir'));
  assert.equal(events.find((e) => e.sessionId === 'h-dir').role, undefined);
});

test('hermes query: current schema works without cwd or git attribution columns', () => {
  const currentColumns = [
    'id', 'source', 'user_id', 'model', 'model_config', 'system_prompt',
    'parent_session_id', 'started_at', 'ended_at', 'end_reason', 'message_count',
    'tool_call_count', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_write_tokens', 'reasoning_tokens', 'billing_provider',
    'billing_base_url', 'billing_mode', 'estimated_cost_usd', 'actual_cost_usd',
    'cost_status', 'cost_source', 'pricing_version', 'title', 'api_call_count',
  ];
  const query = buildHermesSessionQuery(currentColumns);
  assert.match(query, /"input_tokens"/);
  assert.match(query, /"billing_provider"/);
  assert.match(query, /NULL AS "cwd"/);
  assert.match(query, /NULL AS "git_branch"/);
  assert.match(query, /NULL AS "git_repo_root"/);
  assert.doesNotMatch(query, /SELECT[^]*, "cwd"[, ]/);
});

test('hermes query: legacy schema fills every missing optional token field safely', () => {
  const query = buildHermesSessionQuery([
    'id', 'source', 'model', 'input_tokens', 'output_tokens', 'started_at', 'ended_at',
  ]);
  assert.match(query, /0 AS "cache_read_tokens"/);
  assert.match(query, /0 AS "cache_write_tokens"/);
  assert.match(query, /0 AS "reasoning_tokens"/);
  assert.match(query, /NULL AS "actual_cost_usd"/);
  assert.match(query, /COALESCE\("input_tokens", 0\) \+ COALESCE\("output_tokens", 0\) > 0/);
});

test('hermes: preserves xAI OAuth billing path without account identity', () => {
  const [event] = hermesRowsToEvents([{
    id: 'h-xai', source: 'cli', model: 'grok-4.5', input_tokens: 1000, output_tokens: 100,
    cache_read_tokens: 20, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: null,
    billing_provider: 'xai-oauth', cwd: '/w', started_at: 1751300000, ended_at: 1751300100,
  }]);
  assert.equal(event.tool, 'hermes');
  assert.equal(event.provider, 'xai');
  assert.equal(event.billingProvider, 'xai-oauth');
  assert.equal(event.accessPath, 'xAI OAuth (subscription)');
  assert.equal(event.email, undefined);
  assert.equal(event.accountId, undefined);
});

test('delegation report: claude per-turn and hermes per-session splits', () => {
  const claudeEvents = readClaudeUsageEvents(SIDECHAIN_FIXTURE)
    .map((e, i) => ({ ...e, totalCost: e.role === 'worker' ? 0.1 : 1 + i * 0 }));
  const hermesEvents = hermesRowsToEvents([
    { id: 'h-dir', source: 'cli', model: 'glm-5.2', input_tokens: 1000, output_tokens: 400,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.5,
      billing_provider: 'zai', cwd: '/w', started_at: 1751300000, ended_at: 1751300100, parent_session_id: null },
    { id: 'h-w1', source: 'subagent', model: 'gemini-3.1-pro-preview', input_tokens: 2000, output_tokens: 900,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.2,
      billing_provider: '', cwd: '/w', started_at: 1751300010, ended_at: 1751300050, parent_session_id: 'h-dir' },
    { id: 'h-w2', source: 'subagent', model: 'gemini-3.1-pro-preview', input_tokens: 1500, output_tokens: 700,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.1,
      billing_provider: '', cwd: '/w', started_at: 1751300020, ended_at: 1751300060, parent_session_id: 'h-dir' },
    { id: 'h-solo', source: 'tui', model: 'glm-5.2', input_tokens: 500, output_tokens: 200,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, actual_cost_usd: 0.05,
      billing_provider: 'zai', cwd: '/w', started_at: 1751300200, ended_at: 1751300300, parent_session_id: null },
  ]);
  const report = buildDelegationReport([...claudeEvents, ...hermesEvents]);

  const c = report.tools['claude-code'];
  assert.equal(c.attribution, 'per-turn');
  // Only sess-delegate has sidechains; sess-solo must not count.
  assert.equal(c.delegationSessions, 1);
  assert.equal(c.director.calls, 2);          // msg_d1, msg_d2 — not msg_s1
  assert.equal(c.director.cost, 2);           // 2 × $1
  assert.equal(c.worker.calls, 3);
  assert.ok(Math.abs(c.worker.cost - 0.3) < 1e-9);
  assert.equal(c.pairs[0].pair, 'claude-fable-5 → claude-sonnet-5');
  assert.equal(c.pairs[0].calls, 2);
  assert.ok(c.pairs.some((p) => p.pair === 'claude-fable-5 → claude-haiku-4-5'));

  const h = report.tools.hermes;
  assert.equal(h.attribution, 'per-session');
  assert.equal(h.delegationSessions, 1);      // one directing session (h-dir)
  assert.equal(h.director.calls, 1);
  assert.equal(h.director.cost, 0.5);         // h-solo excluded
  assert.equal(h.worker.calls, 2);
  assert.ok(Math.abs(h.worker.cost - 0.3) < 1e-9);
  assert.equal(h.pairs[0].pair, 'glm-5.2 → gemini-3.1-pro-preview');

  assert.equal(report.totals.directorCost, 2.5);
  assert.ok(Math.abs(report.totals.workerCost - 0.6) < 1e-9);
  assert.equal(report.totals.workerCostShare, Math.round((0.6 / 3.1) * 100));
});

// Price a claude event the way the collector does (anthropic = disjoint cache).
function priceClaude(model, e) {
  return priceCall(model, e.inputTokens, e.outputTokens, e.cachedTokens || 0,
    e.cacheCreationTokens || 0, { cachedIncludedInInput: false }).totalCost;
}
const round2 = (n) => Math.round(n * 100) / 100;

test('delegation advisor: worker counterfactual reconciles with priceCall', () => {
  // Real pricing (no totalCost override): price every turn at its own model.
  const events = readClaudeUsageEvents(SIDECHAIN_FIXTURE)
    .map((e) => ({ ...e, totalCost: priceClaude(e.model, e) }));
  const adv = buildDelegationReport(events).tools['claude-code'].advisor;

  const workers = events.filter((e) => e.role === 'worker');
  const expectedActual = round2(workers.reduce((s, e) => s + e.totalCost, 0));
  // Director model is the session's dominant main-thread model: claude-fable-5.
  const expectedAtDirector = round2(workers.reduce((s, e) => s + priceClaude('claude-fable-5', e), 0));

  assert.equal(adv.workerVsDirector.workersPriced, 3);
  assert.equal(adv.workerVsDirector.workersSkipped, 0);
  assert.equal(adv.workerVsDirector.actualCost, expectedActual);
  assert.equal(adv.workerVsDirector.atDirectorCost, expectedAtDirector);
  assert.equal(adv.workerVsDirector.delta, round2(expectedAtDirector - expectedActual));
  // Fable is pricier than sonnet/haiku, so running workers there costs more.
  assert.ok(adv.workerVsDirector.delta > 0);
});

test('delegation advisor: unpriced worker model is skipped, never guessed', () => {
  const events = readClaudeUsageEvents(SIDECHAIN_FIXTURE)
    .map((e) => ({ ...e, totalCost: e.role === 'worker' ? 0.1 : 1 }));
  // Force every worker onto a model with no built-in price.
  for (const e of events) if (e.role === 'worker') e.model = 'totally-made-up-model-x';
  const adv = buildDelegationReport(events).tools['claude-code'].advisor;
  // All workers unpriced → no counterfactual at all (not a zero, not a guess).
  assert.equal(adv.workerVsDirector, null);
});

// ─── Agent name/type + skill extraction (2.1) ────────────────────────────────

const AGENT_TRANSCRIPT = [
  JSON.stringify({ sessionId: 'sess-1', type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'Explore', description: 'Map the parser', model: 'claude-sonnet-5' } },
  ] } }),
  JSON.stringify({ sessionId: 'sess-1', type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: aaa111 (internal ID - do not mention).' }] },
  ] } }),
  JSON.stringify({ sessionId: 'sess-1', type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Build X' } },
  ] } }),
  JSON.stringify({ sessionId: 'sess-1', type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't2', content: 'agentId: bbb222 (internal)' },
  ] } }),
  JSON.stringify({ sessionId: 'sess-1', type: 'assistant', message: { content: [
    { type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'dataviz' } },
  ] } }),
  JSON.stringify({ sessionId: 'sess-1', type: 'assistant', message: { content: [
    { type: 'tool_use', id: 's2', name: 'Skill', input: { skill: 'dataviz' } },
  ] } }),
  '',
].join('\n');

test('agent activity: extracts subagent type/desc/model + agentId join and skills', () => {
  const path = tmpFile('agent-activity.jsonl', AGENT_TRANSCRIPT);
  const a = readClaudeAgentActivity(path);
  assert.equal(a.sessionId, 'sess-1');
  const explore = a.agents.find((x) => x.subagentType === 'Explore');
  assert.equal(explore.agentId, 'aaa111');
  assert.equal(explore.description, 'Map the parser');
  assert.equal(explore.model, 'claude-sonnet-5');
  // agentId parses from a plain-string tool_result too.
  assert.equal(a.agents.find((x) => x.subagentType === 'general-purpose').agentId, 'bbb222');
  assert.deepEqual(a.skills, [{ skill: 'dataviz', count: 2 }]);
});

test('agent breakdown: joins worker cost to type; inline sidechains are unattributed', () => {
  const activities = [{
    agents: [{ agentId: 'aaa111', subagentType: 'Explore', description: 'Map the parser', model: null }],
    skills: [{ skill: 'dataviz', count: 2 }],
  }];
  const events = [
    { role: 'worker', agentId: 'aaa111', model: 'claude-sonnet-5', totalCost: 0.5 },
    { role: 'worker', agentId: 'aaa111', model: 'claude-sonnet-5', totalCost: 0.5 },
    { role: 'worker', totalCost: 0.3 },          // older inline sidechain, no agentId
    { role: undefined, totalCost: 9 },           // director, ignored
  ];
  const b = buildAgentBreakdown(events, activities);
  assert.equal(b.agents.length, 1);
  assert.equal(b.agents[0].subagentType, 'Explore');
  assert.equal(b.agents[0].invocations, 1);
  assert.equal(b.agents[0].turns, 2);
  assert.equal(b.agents[0].cost, 1);
  assert.deepEqual(b.agents[0].models, ['claude-sonnet-5']);
  assert.deepEqual(b.agents[0].sampleDescriptions, ['Map the parser']);
  assert.deepEqual(b.skills, [{ skill: 'dataviz', count: 2 }]);
  assert.deepEqual(b.coverage, { workerTurns: 3, attributedTurns: 2, unattributedTurns: 1 });
});

test('agent breakdown: no activities → empty, never guesses a type', () => {
  const b = buildAgentBreakdown([{ role: 'worker', agentId: 'x', totalCost: 1 }], []);
  assert.deepEqual(b.agents, []);
  assert.equal(b.coverage.unattributedTurns, 1);
});

// ─── Cross-tool orchestration ("used together" windows) ──────────────────────

const MIN = 60 * 1000;
function ev(tool, model, tsMinutes, cost, cwd = '/proj', outputTokens = 100) {
  return { tool, model, timestamp: tsMinutes * MIN, totalCost: cost, cwd, outputTokens };
}

test('orchestration: multi-tool window is detected; single-tool activity is not', () => {
  const events = [
    ev('claude-code', 'claude-fable-5', 0, 1.0),
    ev('codex', 'gpt-5.5', 5, 0.5),           // 5 min after → same window
    ev('claude-code', 'claude-fable-5', 8, 0.3),
    // A codex-only project — must be excluded (single tool).
    ev('codex', 'gpt-5.5', 100, 2.0, '/solo'),
    ev('codex', 'gpt-5.5', 103, 1.0, '/solo'),
  ];
  const r = buildOrchestrationReport(events, { gapMinutes: 10 });
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].project, '/proj');
  assert.equal(r.projects[0].windows, 1);
  assert.equal(r.totals.orchestratedWindows, 1);
  assert.ok(Math.abs(r.projects[0].cost - 1.8) < 1e-9);
  assert.equal(r.projects[0].topCombination, 'claude-code + codex');
  const perTool = Object.fromEntries(r.projects[0].perTool.map(x => [x.tool, x.cost]));
  assert.ok(Math.abs(perTool['claude-code'] - 1.3) < 1e-9);
  assert.ok(Math.abs(perTool['codex'] - 0.5) < 1e-9);
});

test('orchestration: gap boundary merges at the limit, splits beyond it', () => {
  // Exactly 10 min apart → still one window.
  const atLimit = buildOrchestrationReport([
    ev('claude-code', 'claude-fable-5', 0, 1),
    ev('codex', 'gpt-5.5', 10, 1),
  ], { gapMinutes: 10 });
  assert.equal(atLimit.totals.orchestratedWindows, 1);

  // 11 min apart → two single-tool runs, neither orchestrated.
  const beyond = buildOrchestrationReport([
    ev('claude-code', 'claude-fable-5', 0, 1),
    ev('codex', 'gpt-5.5', 11, 1),
  ], { gapMinutes: 10 });
  assert.equal(beyond.totals.orchestratedWindows, 0);
});

test('orchestration: events without a cwd are reported as unattributed, not guessed', () => {
  const events = [
    ev('claude-code', 'claude-fable-5', 0, 1.0),
    ev('codex', 'gpt-5.5', 3, 0.5),
    { tool: 'hermes', model: 'glm-5.2', timestamp: 4 * MIN, totalCost: 0.9, outputTokens: 10 }, // no cwd
  ];
  const r = buildOrchestrationReport(events, { gapMinutes: 10 });
  assert.equal(r.unattributed.events, 1);
  assert.ok(Math.abs(r.unattributed.cost - 0.9) < 1e-9);
  assert.equal(r.totals.orchestratedWindows, 1); // the two cwd events still correlate
  assert.ok(r.basis.includes('heuristic'));
});

// ─── Runaway-agent alarm (burn-rate spikes) ──────────────────────────────────

const H = 3600 * 1000;
function burnEv(tool, tsMs, cost) {
  return { tool, timestamp: tsMs, totalCost: cost, model: 'm', cwd: '/p', outputTokens: 10 };
}

test('burn: flags an hourly spike above baseline and floor', () => {
  const now = 1_000_000_000_000;
  const events = [];
  // 8 baseline active hours at ~$1 each, spread over prior days.
  for (let i = 1; i <= 8; i++) events.push(burnEv('codex', now - i * 6 * H, 1));
  // Recent hour: a runaway burst of $12 across several calls.
  for (let i = 0; i < 4; i++) events.push(burnEv('codex', now - 10 * 60 * 1000, 3));
  const r = buildBurnReport(events, { now, factor: 3, hourlyFloor: 1 });
  const t = r.tools.codex;
  assert.equal(t.recentCost, 12);
  assert.equal(t.baselineHourly, 1);
  assert.equal(t.ratio, 12);
  assert.equal(t.spike, true);
  assert.ok(r.alerts.some((a) => a.tool === 'codex' && a.kind === 'hourly'));
});

test('burn: no spike when recent spend tracks the baseline', () => {
  const now = 1_000_000_000_000;
  const events = [];
  for (let i = 1; i <= 8; i++) events.push(burnEv('codex', now - i * 6 * H, 2));
  events.push(burnEv('codex', now - 5 * 60 * 1000, 2)); // ~1× baseline
  const r = buildBurnReport(events, { now, factor: 3, hourlyFloor: 1 });
  assert.equal(r.tools.codex.spike, false);
  assert.equal(r.alerts.length, 0);
});

test('burn: high ratio below the floor does not alert (small-number noise)', () => {
  const now = 1_000_000_000_000;
  const events = [];
  for (let i = 1; i <= 8; i++) events.push(burnEv('codex', now - i * 6 * H, 0.02));
  events.push(burnEv('codex', now - 5 * 60 * 1000, 0.30)); // 15× baseline but only $0.30
  const r = buildBurnReport(events, { now, factor: 3, hourlyFloor: 1 });
  assert.ok(r.tools.codex.ratio >= 3);
  assert.equal(r.tools.codex.spike, false); // below $1 floor
});

test('burn: stays silent without enough baseline history', () => {
  const now = 1_000_000_000_000;
  const events = [
    burnEv('codex', now - 2 * H, 1),
    burnEv('codex', now - 5 * 60 * 1000, 20),
  ];
  const r = buildBurnReport(events, { now });
  assert.equal(r.tools.codex.hasHistory, false);
  assert.equal(r.tools.codex.spike, false);
});

test('burn: daily spike compares today against the median prior day', () => {
  const now = new Date('2026-07-09T20:00:00Z').getTime();
  const day = 24 * H;
  const events = [];
  // 5 prior days at ~$10 each.
  for (let i = 1; i <= 5; i++) events.push(burnEv('codex', now - i * day, 10));
  // Today: $45.
  events.push(burnEv('codex', now - 30 * 60 * 1000, 45));
  const r = buildBurnReport(events, { now, factor: 3, dailyFloor: 5 });
  assert.equal(r.today.baselineDaily, 10);
  assert.equal(r.today.cost, 45);
  assert.equal(r.today.spike, true);
  assert.ok(r.alerts.some((a) => a.kind === 'daily'));
});

// ─── Burn planner (headroom + time-to-limit at current pace) ─────────────────

function planEv(tool, tsMs, cost, tokens) {
  // Put all tokens in inputTokens; buildBurnPlanner sums the four buckets.
  return { tool, timestamp: tsMs, totalCost: cost, model: 'm', cwd: '/p',
    inputTokens: tokens, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
}

test('plan: computes headroom, tokens remaining, and time-to-limit at pace', () => {
  const now = new Date('2026-07-09T20:00:00Z').getTime();
  const events = [
    planEv('claude-code', now - 30 * 60 * 1000, 1, 50000), // in pace window
    planEv('claude-code', now - 45 * 60 * 1000, 1, 50000), // in pace window
    planEv('claude-code', now - 3 * H, 2, 100000),         // in 5h, outside pace
  ];
  const r = buildBurnPlanner(events, { now, budgets: { claude: { fiveHour: 10, weekly: 50 } }, paceWindowMinutes: 60 });
  const c = r.tools.find((t) => t.tool === 'claude');
  // pace: $2 and 100k tokens in the last hour.
  assert.equal(c.pace.perHourCost, 2);
  assert.equal(c.pace.perHourTokens, 100000);
  // 5h window: $4 used of $10 → $6 left, 40%.
  assert.equal(c.fiveHour.used, 4);
  assert.equal(c.fiveHour.remaining, 6);
  assert.equal(c.fiveHour.percentUsed, 40);
  // costPerToken = 4/200000; $6 remaining ⇒ 300k tokens.
  assert.equal(c.fiveHour.tokensRemaining, 300000);
  // $6 remaining at $2/hr ⇒ 3 hours.
  assert.equal(c.fiveHour.timeToLimit, 3);
  assert.equal(c.fiveHour.timeUnit, 'hour');
  assert.equal(c.fiveHour.status, 'ok');
});

test('plan: no budget yields status no-budget with pace only', () => {
  const now = Date.now();
  const events = [planEv('claude-code', now - 10 * 60 * 1000, 1, 10000)];
  const r = buildBurnPlanner(events, { now, budgets: {}, paceWindowMinutes: 60 });
  const c = r.tools.find((t) => t.tool === 'claude');
  assert.equal(c.fiveHour.status, 'no-budget');
  assert.equal(c.fiveHour.budget, null);
  assert.equal(c.fiveHour.used, 1);
});

test('plan: over budget clamps remaining and drops the ETA', () => {
  const now = Date.now();
  const events = [planEv('claude-code', now - 20 * 60 * 1000, 4, 100000)];
  const r = buildBurnPlanner(events, { now, budgets: { claude: { fiveHour: 3 } }, paceWindowMinutes: 60 });
  const c = r.tools.find((t) => t.tool === 'claude');
  assert.equal(c.fiveHour.status, 'over');
  assert.equal(c.fiveHour.remaining, 0);
  assert.equal(c.fiveHour.timeToLimit, null);
  assert.equal(c.fiveHour.percentUsed, 133);
});

test('plan: idle (no recent activity) gives no false countdown', () => {
  const now = Date.now();
  const events = [planEv('claude-code', now - 3 * H, 2, 100000)]; // within 5h, not last hour
  const r = buildBurnPlanner(events, { now, budgets: { claude: { fiveHour: 10 } }, paceWindowMinutes: 60 });
  const c = r.tools.find((t) => t.tool === 'claude');
  assert.equal(c.pace.perHourCost, 0);
  assert.equal(c.fiveHour.remaining, 8);
  assert.equal(c.fiveHour.timeToLimit, null); // pace 0 ⇒ no ETA
  assert.equal(c.fiveHour.status, 'ok');
});

test('plan: global daily headroom spans all tools', () => {
  const now = new Date('2026-07-09T20:00:00Z').getTime();
  const events = [
    planEv('claude-code', now - 20 * 60 * 1000, 2, 40000),
    planEv('codex', now - 40 * 60 * 1000, 1, 20000),
  ];
  const r = buildBurnPlanner(events, { now, budgets: { global: { daily: 20 } }, paceWindowMinutes: 60 });
  assert.equal(r.global.daily.used, 3);
  assert.equal(r.global.daily.remaining, 17);
  assert.equal(r.global.pace.perHourCost, 3);
});

test('plan: grok budget combines direct and Hermes xAI provider usage', () => {
  const now = Date.UTC(2026, 6, 12, 12);
  const report = buildBurnPlanner([
    { timestamp: now - 1000, tool: 'grok', provider: 'xai', totalCost: 1, inputTokens: 100, outputTokens: 10 },
    { timestamp: now - 2000, tool: 'hermes', provider: 'xai', billingProvider: 'xai-oauth', totalCost: 2, inputTokens: 200, outputTokens: 20 },
    { timestamp: now - 3000, tool: 'hermes', provider: 'google', totalCost: 9, inputTokens: 900, outputTokens: 90 },
  ], { now, tools: ['grok'], budgets: { grok: { fiveHour: 10 } } });
  assert.equal(report.tools[0].fiveHour.used, 3);
  assert.equal(report.tools[0].fiveHour.percentUsed, 30);
  assert.equal(report.tools[0].fiveHour.tokens, 330);
});

// ─── Savings report (routine premium turns → cheaper tier) ───────────────────

test('savings: flags routine premium turns and reconciles with priceCall', () => {
  const events = [];
  // 10 routine Fable turns (short in/out, no cache).
  for (let i = 0; i < 10; i++) {
    events.push({ tool: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', source: 'claude-transcript-usage',
      inputTokens: 300, outputTokens: 150, cachedTokens: 0, cacheCreationTokens: 0,
      timestamp: Date.now() - i * 1000, totalCost: priceCall('claude-fable-5', 300, 150, 0, 0, { cachedIncludedInInput: false }).totalCost });
  }
  // 2 non-routine Fable turns (huge context) — correctly premium, excluded.
  for (let i = 0; i < 2; i++) {
    events.push({ tool: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', source: 'claude-transcript-usage',
      inputTokens: 1000, outputTokens: 1500, cachedTokens: 180000, cacheCreationTokens: 0,
      timestamp: Date.now(), totalCost: priceCall('claude-fable-5', 1000, 1500, 180000, 0, { cachedIncludedInInput: false }).totalCost });
  }
  const r = buildSavingsReport(events, { windowDays: 30 });
  const g = r.models.find((m) => m.model === 'claude-fable-5');
  assert.equal(g.cheaperModel, 'claude-haiku-4-5');
  assert.equal(g.routineTurns, 10);
  assert.equal(g.totalTurns, 12);
  assert.equal(r.keptPremium.turns, 2);

  // Reconcile the cheaper-tier figure against a direct priceCall.
  const perTurnCheaper = priceCall('claude-haiku-4-5', 300, 150, 0, 0, { cachedIncludedInInput: false }).totalCost;
  assert.ok(Math.abs(g.atCheaperCost - Math.round(perTurnCheaper * 10 * 100) / 100) < 0.01);
  assert.ok(g.savings > 0);
  assert.equal(r.totals.monthlySavings, Math.round((r.totals.savings / 30) * 30 * 100) / 100);
});

test('savings: cheaper-than-premium models produce no opportunity', () => {
  // Haiku turns have no cheaper same-provider tier defined → skipped.
  const events = [{ tool: 'claude-code', provider: 'anthropic', model: 'claude-haiku-4-5', source: 'claude-transcript-usage',
    inputTokens: 300, outputTokens: 150, cachedTokens: 0, cacheCreationTokens: 0, timestamp: Date.now(), totalCost: 0.01 }];
  const r = buildSavingsReport(events, { windowDays: 30 });
  assert.equal(r.models.length, 0);
  assert.equal(r.totals.savings, 0);
});

test('savings: hermes session aggregates are excluded from the heuristic', () => {
  const events = [{ tool: 'hermes', provider: 'anthropic', model: 'claude-fable-5', source: 'hermes-state-db',
    inputTokens: 300, outputTokens: 150, cachedTokens: 0, cacheCreationTokens: 0, timestamp: Date.now(), totalCost: 0.05 }];
  const r = buildSavingsReport(events, { windowDays: 30 });
  assert.equal(r.models.length, 0);
});

// ─── Routing policy export (savings --emit-policy) ───────────────────────────

function savingsFixtureReport() {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ tool: 'claude-code', provider: 'anthropic', model: 'claude-fable-5', source: 'claude-transcript-usage',
      inputTokens: 300, outputTokens: 150, cachedTokens: 0, cacheCreationTokens: 0,
      timestamp: Date.now(), totalCost: priceCall('claude-fable-5', 300, 150, 0, 0, { cachedIncludedInInput: false }).totalCost });
  }
  return buildSavingsReport(events, { windowDays: 30 });
}

test('routing policy: rules mirror savings models and routine thresholds', () => {
  const report = savingsFixtureReport();
  const policy = buildRoutingPolicy(report);
  assert.equal(policy.rules.length, report.models.length);
  const rule = policy.rules[0];
  assert.equal(rule.match.model, 'claude-fable-5');
  assert.equal(rule.route, 'claude-haiku-4-5');
  // Thresholds must be the exact heuristic bounds the savings figure used.
  assert.equal(rule.match.maxInputTokens, report.thresholds.maxInputTokens);
  assert.equal(rule.match.maxOutputTokens, report.thresholds.maxOutputTokens);
  assert.equal(rule.match.maxCachedContextTokens, report.thresholds.maxCacheTokens);
  assert.equal(rule.evidence.routineTurns, 10);
  assert.equal(policy.estimatedWindowSavings, report.totals.savings);
});

test('routing policy: formats emit valid json / litellm yaml / openrouter json', () => {
  const policy = buildRoutingPolicy(savingsFixtureReport());
  const asJson = JSON.parse(formatRoutingPolicy(policy, 'json'));
  assert.equal(asJson.rules[0].route, 'claude-haiku-4-5');

  const litellm = formatRoutingPolicy(policy, 'litellm');
  assert.ok(litellm.includes('model_list:'));
  assert.ok(litellm.includes('model_name: claude-fable-5-routed'));
  assert.ok(litellm.includes('model: claude-haiku-4-5'));
  assert.ok(litellm.includes('model: claude-fable-5'));
  assert.ok(!litellm.includes('undefined'));
  assert.ok(litellm.startsWith('#')); // estimate disclaimer up top

  const or = JSON.parse(formatRoutingPolicy(policy, 'openrouter'));
  assert.deepEqual(or.routes[0].request.models, ['claude-haiku-4-5', 'claude-fable-5']);

  assert.throws(() => formatRoutingPolicy(policy, 'bogus'), /unknown policy format/);
});

test('routing policy: empty savings produces an empty but valid policy', () => {
  const policy = buildRoutingPolicy(buildSavingsReport([], { windowDays: 30 }));
  assert.equal(policy.rules.length, 0);
  assert.equal(policy.estimatedWindowSavings, 0);
  assert.ok(formatRoutingPolicy(policy, 'litellm').includes('nothing to route cheaper'));
});

// ─── Session trace (tokimeter trace <session>) ───────────────────────────────

function traceEv(sessionId, { ts, cost = 1, role, model = 'claude-fable-5', tool = 'claude-code' } = {}) {
  return { tool, provider: 'anthropic', model, sessionId, cwd: '/Users/x/proj', timestamp: ts,
    inputTokens: 100, outputTokens: 50, cachedTokens: 900, cacheCreationTokens: 100, totalCost: cost,
    ...(role ? { role } : {}) };
}

test('trace: unique prefix returns full session economics', () => {
  const t0 = Date.parse('2026-07-09T10:00:00Z');
  const events = [
    traceEv('abc-123', { ts: t0, cost: 2 }),
    traceEv('abc-123', { ts: t0 + 10 * 60000, cost: 1, role: 'worker', model: 'claude-haiku-4-5' }),
    traceEv('abc-123', { ts: t0 + 20 * 60000, cost: 3 }),
    traceEv('zzz-999', { ts: t0, cost: 5 }),
  ];
  const { trace } = buildSessionTrace(events, 'abc');
  assert.equal(trace.sessionId, 'abc-123');
  assert.equal(trace.turns, 3);
  assert.equal(trace.cost, 6);
  assert.equal(trace.durationMinutes, 20);
  assert.equal(trace.delegation.workerTurns, 1);
  assert.equal(trace.delegation.workerCost, 1);
  assert.equal(trace.delegation.directorTurns, 2);
  assert.equal(trace.byModel[0].model, 'claude-fable-5'); // costliest first
  // cache: read 900×3 of context (100+900+100)×3 → 81%
  assert.equal(trace.cache.hitRate, 82);
  assert.equal(trace.cache.readWriteRatio, 9);
  assert.equal(trace.topTurns[0].cost, 3);
});

test('trace: ambiguous or empty query lists recent sessions', () => {
  const t0 = Date.parse('2026-07-09T10:00:00Z');
  const events = [traceEv('abc-1', { ts: t0 }), traceEv('abc-2', { ts: t0 + 60000 })];
  const ambiguous = buildSessionTrace(events, 'abc');
  assert.equal(ambiguous.matches.length, 2);
  assert.equal(ambiguous.matches[0].sessionId, 'abc-2'); // most recent first
  const none = buildSessionTrace(events, 'nope');
  assert.equal(none.matches.length, 0);
});

test('trace: tools without role markers say delegation is not attributable', () => {
  const { trace } = buildSessionTrace([traceEv('cx-1', { ts: Date.now(), tool: 'codex' })], 'cx-1');
  assert.ok(trace.delegation.basis.includes('no director/worker markers'));
});

// ─── Report export renderers (--md / --html) ─────────────────────────────────

const RENDER_FIXTURE = {
  generatedAt: '2026-07-09T00:00:00.000Z',
  windowDays: 7,
  costBasis: 'API-equivalent estimate from exact local token counts; notional (not billed) on Claude/ChatGPT subscriptions',
  totals: { cost: 12.34, roughEstimateCost: 3.21, unpricedCalls: 1, calls: 42, inputTokens: 50000, outputTokens: 8000, cachedTokens: 2500000, cacheCreationTokens: 120000 },
  today: { cost: 1.5, calls: 3 },
  last7Days: { cost: 12.34, calls: 42 },
  cacheReadSavings: 9.87,
  byTool: [{ name: 'claude-code', cost: 10, calls: 40 }, { name: 'codex', cost: 2.34, calls: 2 }],
  byProvider: [{ name: 'Anthropic', cost: 10, calls: 40 }, { name: 'OpenAI', cost: 2.34, calls: 2 }],
  byAccessPath: [{ name: 'xAI OAuth (subscription)', cost: 1, calls: 1 }],
  pricingSources: [
    { name: 'verified built-in', cost: 12.34, roughEstimateCost: 0, calls: 41 },
    { name: 'fallback / unpriced', cost: 0, roughEstimateCost: 3.21, unpricedCalls: 1, calls: 1 },
  ],
  byModel: [{ name: 'claude-fable-5', cost: 12.34, calls: 42 }],
  byProject: [{ name: '~/proj/<script>', cost: 12.34, calls: 42 }],
  byDay: [{ date: '2026-07-08', cost: 6, calls: 20 }, { date: '2026-07-09', cost: 6.34, calls: 22 }],
  savings: { windowDays: 7, totals: { routineCost: 3, atCheaperCost: 0.5, savings: 2.5 }, basis: 'metadata heuristic' },
  insights: { cacheHitRate: 91, coldCache: [{ project: '~/cold', cacheWriteTokens: 2100000, cacheReadTokens: 300000, cacheWriteCost: 4.2 }], largeContext: { threshold: 150000, turns: 2, cost: 1.1 } },
};

test('report --md: renders totals, per-project chargeback table, and estimate disclaimer', () => {
  const md = renderReportMarkdown(RENDER_FIXTURE);
  assert.ok(md.includes('# Tokimeter report — last 7 days'));
  assert.ok(md.includes('| Total (window) | ~$12.34 | ~$3.21 (excluded) | 42 |'));
  assert.ok(md.includes('## Pricing provenance'));
  assert.ok(md.includes('## By project'));
  assert.ok(md.includes('## By provider'));
  assert.ok(md.includes('## By access path'));
  assert.ok(md.includes('~/proj/<script>'));
  assert.ok(md.includes('2.5M cache read'));
  assert.ok(md.includes('Savings opportunity (upper bound)'));
  assert.ok(md.includes('Cache hit rate: 91%'));
  assert.ok(md.includes('not a bill'));
});

test('report --html: valid standalone page with escaped project names', () => {
  const html = renderReportHtml(RENDER_FIXTURE);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('&lt;script&gt;'));          // project name escaped
  assert.ok(!html.includes('~/proj/<script>'));        // never raw
  assert.ok(html.includes('By project'));
  assert.ok(html.includes('By provider'));
  assert.ok(html.includes('~$12.34'));
  assert.ok(html.includes('~$3.21 (excluded)'));
  assert.ok(html.includes('not a bill'));
  assert.ok(!html.includes('src=') && !html.includes('href=')); // self-contained
});

test('report renderers: quiet on empty savings and missing insights', () => {
  const bare = { ...RENDER_FIXTURE, savings: { totals: { savings: 0 } }, insights: undefined, byDay: [], coldCache: undefined };
  const md = renderReportMarkdown(bare);
  assert.ok(!md.includes('Savings opportunity'));
  assert.ok(!md.includes('## Insights'));
  const html = renderReportHtml(bare);
  assert.ok(!html.includes('Savings opportunity'));
});

// ─── "My month in AI" card ───────────────────────────────────────────────────

const CARD_EVENTS = [
  { timestamp: Date.UTC(2026, 5, 3, 10), tool: 'claude-code', model: 'claude-sonnet-5', totalCost: 4, inputTokens: 1000, outputTokens: 500, cachedTokens: 2_000_000, cacheCreationTokens: 100, sessionId: 'sec-ret-1', cwd: '/Users/x/secret-project' },
  { timestamp: Date.UTC(2026, 5, 3, 12), tool: 'claude-code', model: 'claude-sonnet-5', totalCost: 2, inputTokens: 500, outputTokens: 200, cachedTokens: 0, cacheCreationTokens: 0 },
  { timestamp: Date.UTC(2026, 5, 9, 9), tool: 'codex', model: 'gpt-5.1-codex', totalCost: 1.5, inputTokens: 300, outputTokens: 100, cachedTokens: 0, cacheCreationTokens: 0 },
  { timestamp: Date.UTC(2026, 6, 1, 0), tool: 'codex', model: 'gpt-5.1-codex', totalCost: 99, inputTokens: 1, outputTokens: 1 }, // next month — excluded
];

test('buildMonthCard: month filter, totals, top lists, shares, active days', () => {
  const card = buildMonthCard(CARD_EVENTS, { month: '2026-06' });
  assert.equal(card.month, '2026-06');
  assert.equal(card.monthLabel, 'June 2026');
  assert.equal(card.totals.cost, 7.5);
  assert.equal(card.totals.calls, 3);
  assert.equal(card.activeDays, 2);
  assert.equal(card.busiestDay.date, '2026-06-03');
  assert.equal(card.topTools[0].name, 'claude-code');
  assert.equal(card.topTools[0].cost, 6);
  assert.equal(card.topTools[0].share, 80);
  assert.equal(card.topModels[0].name, 'claude-sonnet-5');
  assert.ok(card.cacheHitRate > 0);
  assert.ok(card.cacheReadSavings > 0);
  assert.ok(card.basis.includes('not a bill'));
});

test('buildMonthCard: no projects, paths, or session ids in the card (no PII)', () => {
  const card = buildMonthCard(CARD_EVENTS, { month: '2026-06' });
  const json = JSON.stringify(card);
  assert.ok(!json.includes('secret-project'));
  assert.ok(!json.includes('sec-ret-1'));
  assert.ok(!json.includes('cwd'));
  assert.ok(!json.includes('sessionId'));
});

test('buildMonthCard: defaults to the current month and survives zero events', () => {
  const now = Date.UTC(2026, 5, 15);
  const card = buildMonthCard([], { now });
  assert.equal(card.month, '2026-06');
  assert.equal(card.totals.cost, 0);
  assert.equal(card.activeDays, 0);
  assert.equal(card.busiestDay, null);
  assert.equal(card.cacheHitRate, null);
  assert.deepEqual(card.topTools, []);
});

test('renderMonthCardSvg: self-contained SVG with escaped names and disclaimer', () => {
  const card = buildMonthCard([
    { ...CARD_EVENTS[0], tool: `claude<code>&"'` },
    ...CARD_EVENTS.slice(1),
  ], { month: '2026-06' });
  card.monthLabel = `June "special" <2026> & 'friends'`;
  const svg = renderMonthCardSvg(card);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('claude&lt;code&gt;&amp;&quot;&#39;'));
  assert.ok(!svg.includes('claude<code>'));
  assert.ok(svg.includes('June &quot;special&quot; &lt;2026&gt; &amp; &#39;friends&#39;'));
  assert.ok(!svg.includes('June "special" <2026>'));
  assert.ok(svg.includes('~$7.50'));
  assert.ok(svg.includes('not a bill'));
  assert.ok(!svg.includes('href=') && !svg.includes('src=') && !svg.includes('<script'));
});

// ─── opencode ────────────────────────────────────────────────────────────────

const OPENCODE_MSG = {
  id: 'msg_oc1',
  sessionID: 'ses_abc',
  role: 'assistant',
  modelID: 'claude-sonnet-5',
  providerID: 'anthropic',
  cost: 0.042,
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 8000, write: 2000 } },
  time: { created: Date.UTC(2026, 6, 5, 10), completed: Date.UTC(2026, 6, 5, 10, 1) },
  path: { root: '/Users/dev/ocproj' },
};

test('opencode message: maps disjoint token buckets, embedded cost, and metadata', () => {
  const e = opencodeMessageToEvent(OPENCODE_MSG);
  assert.equal(e.tool, 'opencode');
  assert.equal(e.provider, 'anthropic');
  assert.equal(e.model, 'claude-sonnet-5');
  assert.equal(e.inputTokens, 1200);
  assert.equal(e.outputTokens, 300);
  assert.equal(e.cachedTokens, 8000);
  assert.equal(e.cacheCreationTokens, 2000);
  assert.equal(e.reasoningTokens, 50);
  assert.equal(e.cachedDisjoint, true);
  assert.equal(e.totalCost, 0.042);           // opencode's own price is authoritative
  assert.equal(e.cwd, '/Users/dev/ocproj');
  assert.equal(e.sessionId, 'ses_abc');
  assert.equal(e.externalId, 'opencode:msg_oc1');
  assert.equal(e.timestamp, Date.UTC(2026, 6, 5, 10));
});

test('opencode message: skips non-assistant, zero-usage, missing tokens, stale', () => {
  assert.equal(opencodeMessageToEvent({ ...OPENCODE_MSG, role: 'user' }), null);
  assert.equal(opencodeMessageToEvent({ ...OPENCODE_MSG, tokens: undefined }), null);
  assert.equal(opencodeMessageToEvent({ ...OPENCODE_MSG, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }), null);
  assert.equal(opencodeMessageToEvent(OPENCODE_MSG, { sinceMs: Date.UTC(2026, 6, 6) }), null);
  assert.equal(opencodeMessageToEvent(null), null);
});

test('opencode message: zero/negative cost falls back to our estimate; negatives clamp', () => {
  const e = opencodeMessageToEvent({ ...OPENCODE_MSG, cost: 0, tokens: { input: -5, output: 300, cache: { read: 0, write: 0 } } });
  assert.equal(e.totalCost, 0);               // 0 → collectLocalUsageEvents prices it
  assert.equal(e.inputTokens, 0);
  assert.equal(e.outputTokens, 300);
});

test('opencode file reader: parses msg_*.json and uses filename as fallback id', () => {
  const { id, ...noId } = OPENCODE_MSG;
  const path = tmpFile('msg_fromfile.json', JSON.stringify(noId));
  const e = readOpencodeMessageFile(path);
  assert.equal(e.externalId, 'opencode:msg_fromfile');
  assert.equal(readOpencodeMessageFile(tmpFile('msg_junk.json', '{nope')), null);
});

test('opencode sqlite rows: parses data column, dedupes, tolerates junk rows', () => {
  const rows = [
    { id: 'row1', data: JSON.stringify(OPENCODE_MSG) },
    { id: 'row1-dup', data: JSON.stringify(OPENCODE_MSG) },          // same message id → deduped
    { id: 'row2', data: JSON.stringify({ ...OPENCODE_MSG, id: undefined, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } }) },
    { id: 'bad', data: '{not json' },
    { data: null },
    null,
  ];
  const events = opencodeRowsToEvents(rows);
  assert.equal(events.length, 2);
  assert.equal(events[0].externalId, 'opencode:msg_oc1');
  assert.equal(events[1].externalId, 'opencode:row2');               // row id fallback
});

// ─── Cline ───────────────────────────────────────────────────────────────────

const CLINE_UI = [
  { ts: Date.UTC(2026, 6, 4, 9), type: 'say', say: 'text', text: 'hello' },
  { ts: Date.UTC(2026, 6, 4, 9, 1), type: 'say', say: 'api_req_started',
    text: JSON.stringify({ request: 'SECRET PROMPT CONTENT', tokensIn: 1500, tokensOut: 400, cacheWrites: 2000, cacheReads: 30000, cost: 0.031 }) },
  { ts: Date.UTC(2026, 6, 4, 9, 5), type: 'say', say: 'api_req_started',
    text: JSON.stringify({ request: 'MORE CONTENT', tokensIn: 700, tokensOut: 100 }) },
  { ts: Date.UTC(2026, 6, 4, 9, 6), type: 'say', say: 'deleted_api_reqs',
    text: JSON.stringify({ tokensIn: 50, tokensOut: 20, cost: 0 }) },
  { ts: Date.UTC(2026, 6, 4, 9, 7), type: 'say', say: 'api_req_started', text: '{broken' },
  { ts: Date.UTC(2026, 6, 4, 9, 8), type: 'say', say: 'api_req_started',
    text: JSON.stringify({ tokensIn: 0, tokensOut: 0 }) },
];
const CLINE_MODELS = [
  { ts: Date.UTC(2026, 6, 4, 9), model_id: 'claude-sonnet-5', model_provider_id: 'anthropic', mode: 'act' },
  { ts: Date.UTC(2026, 6, 4, 9, 4), model_id: 'claude-haiku-4-5', model_provider_id: 'anthropic', mode: 'act' },
];

test('cline task: usage events with model attribution from task metadata', () => {
  const events = clineTaskToEvents(CLINE_UI, { taskId: 'task-77', modelUsage: CLINE_MODELS });
  assert.equal(events.length, 3);                        // junk + zero-usage skipped
  assert.equal(events[0].model, 'claude-sonnet-5');      // before the model switch
  assert.equal(events[0].inputTokens, 1500);
  assert.equal(events[0].cachedTokens, 30000);
  assert.equal(events[0].cacheCreationTokens, 2000);
  assert.equal(events[0].totalCost, 0.031);              // Cline's own price kept
  assert.equal(events[0].cachedDisjoint, true);
  assert.equal(events[1].model, 'claude-haiku-4-5');     // after the switch
  assert.equal(events[1].totalCost, 0);                  // no cost → we price it
  assert.equal(events[0].tool, 'cline');
  assert.equal(events[0].sessionId, 'task-77');
});

test('cline task: prompt content is never kept on events (no PII)', () => {
  const events = clineTaskToEvents(CLINE_UI, { taskId: 'task-77', modelUsage: CLINE_MODELS });
  const json = JSON.stringify(events);
  assert.ok(!json.includes('SECRET PROMPT CONTENT'));
  assert.ok(!json.includes('MORE CONTENT'));
  assert.ok(!json.includes('request'));
});

test('cline task: sinceMs filter, missing metadata, junk input survive', () => {
  const recent = clineTaskToEvents(CLINE_UI, { sinceMs: Date.UTC(2026, 6, 4, 9, 4) });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].model, 'unknown');              // no metadata → unknown model
  assert.deepEqual(clineTaskToEvents(null), []);
  assert.deepEqual(clineTaskToEvents('nope'), []);
});

test('cline task dir reader: reads ui_messages + task_metadata from disk', () => {
  const dir = join(TMP, 'cline-task-42');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(CLINE_UI));
  writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ model_usage: CLINE_MODELS, files_in_context: [{ path: '/secret/file.ts' }] }));
  const events = readClineTaskEvents(dir);
  assert.equal(events.length, 3);
  assert.equal(events[0].sessionId, 'cline-task-42');
  assert.ok(!JSON.stringify(events).includes('/secret/file.ts'));
  assert.deepEqual(readClineTaskEvents(join(TMP, 'no-such-task')), []);
});

test('cline 3 session: reads Codex subscription metrics without message content', () => {
  const payload = {
    sessionId: 'cline-v3',
    system_prompt: 'SECRET SYSTEM CONTENT',
    messages: [
      { id: 'u1', role: 'user', ts: 1783894357000, content: [{ type: 'text', text: 'SECRET USER CONTENT' }] },
      { id: 'a1', role: 'assistant', ts: 1783894376221,
        content: [{ type: 'text', text: 'SECRET RESPONSE CONTENT' }],
        modelInfo: { id: 'gpt-5.4', provider: 'openai-codex', family: 'gpt' },
        metrics: { inputTokens: 3807, outputTokens: 55, cacheReadTokens: 20, cacheWriteTokens: 5, cost: 0.0103425 } },
    ],
  };
  const [event] = clineSessionMessagesToEvents(payload, { sessionId: 'cline-v3', cwd: '/work' });
  assert.equal(event.tool, 'cline');
  assert.equal(event.provider, 'openai');
  assert.equal(event.billingProvider, 'openai-codex');
  assert.equal(event.accessPath, 'Codex OAuth (subscription)');
  assert.equal(event.model, 'gpt-5.4');
  assert.equal(event.inputTokens, 3807);
  assert.equal(event.outputTokens, 55);
  assert.equal(event.cachedTokens, 20);
  assert.equal(event.totalCost, 0.0103425);
  assert.ok(!JSON.stringify(event).includes('SECRET'));
});

test('cline 3 session dir reader: joins numeric messages to metadata', () => {
  const dir = join(TMP, 'cline-session-v3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cline-session-v3.json'), JSON.stringify({
    session_id: 'cline-session-v3', provider: 'openai-codex', model: 'gpt-5.4',
    workspace_root: '/work', prompt: 'SECRET PROMPT',
  }));
  writeFileSync(join(dir, 'cline-session-v3.messages.json'), JSON.stringify({
    sessionId: 'cline-session-v3', system_prompt: 'SECRET SYSTEM', messages: [{
      id: 'a1', role: 'assistant', ts: 1783894376221, content: [{ text: 'SECRET RESPONSE' }],
      modelInfo: { id: 'gpt-5.4', provider: 'openai-codex' },
      metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.001 },
    }],
  }));
  const [event] = readClineSessionEvents(dir);
  assert.equal(event.sessionId, 'cline-session-v3');
  assert.equal(event.cwd, '/work');
  assert.equal(event.totalCost, 0.001);
  assert.ok(!JSON.stringify(event).includes('SECRET'));
});

// ─── GitHub Copilot CLI (OTel JSONL) ────────────────────────────────────────

const COPILOT_OTEL_LINES = [
  // chat span with usage
  JSON.stringify({ type: 'span', name: 'chat gpt-5.6-terra', traceId: 't1', spanId: 's1',
    startTime: [1783600000, 0], endTime: [1783600010, 500000000],
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'gpt-5.6-terra',
      'gen_ai.conversation.id': 'sess-1', 'gen_ai.response.id': 'resp-1',
      'gen_ai.usage.input_tokens': 12000, 'gen_ai.usage.output_tokens': 800,
      'gen_ai.usage.cache_read.input_tokens': 10000 } }),
  // inference log for the SAME trace — must be suppressed
  JSON.stringify({ traceId: 't1', timestamp: 1783600011000,
    attributes: { 'event.name': 'gen_ai.client.inference.operation.details',
      'gen_ai.usage.input_tokens': 12000, 'gen_ai.usage.output_tokens': 800 } }),
  // standalone inference log on another trace — kept, model via trace context
  JSON.stringify({ traceId: 't2', timestamp: '2026-07-09T10:00:00.000Z',
    attributes: { 'event.name': 'gen_ai.client.inference.operation.details',
      'session.id': 'sess-2',
      'gen_ai.usage.input_tokens': 500, 'gen_ai.usage.output_tokens': 90,
      'gen_ai.usage.reasoning_tokens': 40 } }),
  JSON.stringify({ traceId: 't2', type: 'span', name: 'other',
    attributes: { 'gen_ai.request.model': 'claude-sonnet-5' } }),
  // junk lines
  '{broken json with "attributes"',
  JSON.stringify({ attributes: { 'gen_ai.usage.input_tokens': 0 } }),
];

test('copilot otel: chat span wins, duplicate inference log suppressed', () => {
  const events = copilotOtelTextToEvents(COPILOT_OTEL_LINES.join('\n'));
  assert.equal(events.length, 2);
  const chat = events.find((e) => e.model === 'gpt-5.6-terra');
  assert.equal(chat.inputTokens, 2000);        // cache reads subtracted from input
  assert.equal(chat.cachedTokens, 10000);
  assert.equal(chat.outputTokens, 800);
  assert.equal(chat.sessionId, 'sess-1');
  assert.equal(chat.tool, 'copilot');
  assert.equal(chat.cachedDisjoint, true);
  assert.equal(chat.timestamp, 1783600010500); // [s, ns] endTime normalized to ms
});

test('copilot otel: trace context supplies model; reasoning tokens counted', () => {
  const events = copilotOtelTextToEvents(COPILOT_OTEL_LINES.join('\n'));
  const log = events.find((e) => e.sessionId === 'sess-2');
  assert.equal(log.model, 'claude-sonnet-5');  // from the sibling span on t2
  assert.equal(log.reasoningTokens, 40);
  assert.equal(log.timestamp, Date.parse('2026-07-09T10:00:00.000Z'));
});

test('copilot otel: sinceMs filter and mtime fallback for timestampless records', () => {
  const none = copilotOtelTextToEvents(COPILOT_OTEL_LINES.join('\n'), { sinceMs: Date.parse('2027-01-01') });
  assert.equal(none.length, 0);
  const noTs = JSON.stringify({ type: 'span', name: 'chat x', traceId: 't9', spanId: 's9',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.6-luna', 'gen_ai.usage.output_tokens': 10 } });
  const withFallback = copilotOtelTextToEvents(noTs, { fallbackMs: 1783600000000 });
  assert.equal(withFallback.length, 1);
  assert.equal(withFallback[0].timestamp, 1783600000000);
  const dropped = copilotOtelTextToEvents(noTs, {});   // no timestamp at all → dropped
  assert.equal(dropped.length, 0);
});

// ─── Cursor CLI (stop-hook capture) ─────────────────────────────────────────

const CURSOR_STOP_PAYLOAD = {
  conversation_id: 'conv-9',
  generation_id: 'gen-123',
  model: 'claude-sonnet-5',
  status: 'completed',
  loop_count: 3,
  input_tokens: 900,
  output_tokens: 250,
  cache_read_tokens: 40000,
  cache_write_tokens: 1500,
  workspace_root: '/Users/x/proj',
  hook_event_name: 'stop',
  cursor_version: '2026.07.09-a3815c0',
};

test('cursor stop payload: maps disjoint buckets to a metadata-only record', () => {
  const r = cursorStopPayloadToRecord(CURSOR_STOP_PAYLOAD, { now: 1783700000000 });
  assert.equal(r.ts, 1783700000000);
  assert.equal(r.conversationId, 'conv-9');
  assert.equal(r.generationId, 'gen-123');
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(r.inputTokens, 900);
  assert.equal(r.outputTokens, 250);
  assert.equal(r.cachedTokens, 40000);
  assert.equal(r.cacheCreationTokens, 1500);
  assert.equal(r.cursorVersion, '2026.07.09-a3815c0');
  assert.equal(r.hookEvent, 'stop');
  assert.equal(r.cwd, '/Users/x/proj');
  assert.ok(!('loop_count' in r));
});

test('cursor stop payload: tokenless payloads are dropped (grok-forwarded stops)', () => {
  assert.equal(cursorStopPayloadToRecord({ hookEventName: 'stop', sessionId: 'grok-1' }), null);
  assert.equal(cursorStopPayloadToRecord({
    ...CURSOR_STOP_PAYLOAD,
    model: 'grok-4.5-fast-xhigh',
    hook_event_name: undefined,
    cursor_version: undefined,
  }), null);
  assert.equal(cursorStopPayloadToRecord({ ...CURSOR_STOP_PAYLOAD, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }), null);
  assert.equal(cursorStopPayloadToRecord(null), null);
  assert.equal(cursorStopPayloadToRecord('nope'), null);
});

test('cursor stop payload: current Auto model and workspace_roots are normalized', () => {
  const r = cursorStopPayloadToRecord({
    ...CURSOR_STOP_PAYLOAD,
    model: 'default',
    workspace_root: undefined,
    workspace_roots: ['/Users/x/current-project'],
  });
  assert.equal(r.model, 'cursor-auto');
  assert.equal(r.cwd, '/Users/x/current-project');
});

test('cursor usage log: records become priced, deduped events', () => {
  const rec = cursorStopPayloadToRecord(CURSOR_STOP_PAYLOAD, { now: 1783700000000 });
  rec.totalCost = 0.0123;
  const path = tmpFile('cursor-usage.jsonl', [
    JSON.stringify(rec),
    JSON.stringify(rec),                                    // hook re-fire → dedupe
    '{broken json',
    JSON.stringify({ ...rec, generationId: 'gen-124', ts: 1783700100000, totalCost: 0 }),
  ].join('\n') + '\n');
  const events = readCursorUsageEvents(path);
  assert.equal(events.length, 2);
  assert.equal(events[0].externalId, 'cursor:gen-123');
  assert.equal(events[0].tool, 'cursor');
  assert.equal(events[0].cachedDisjoint, true);
  assert.equal(events[0].totalCost, 0.0123);                // priced at capture time
  assert.equal(events[1].totalCost, 0);                     // unpriced → engine prices later
  assert.equal(events[1].externalId, 'cursor:gen-124');
  const since = readCursorUsageEvents(path, { sinceMs: 1783700050000 });
  assert.equal(since.length, 1);
  assert.deepEqual(readCursorUsageEvents(join(TMP, 'missing.jsonl')), []);
});

test('cursor usage log: legacy Grok compatibility forwards are excluded', () => {
  const rec = cursorStopPayloadToRecord(CURSOR_STOP_PAYLOAD, { now: 1783700000000 });
  const path = tmpFile('cursor-grok-forward.jsonl', JSON.stringify({
    ...rec,
    model: 'grok-4.5-fast-xhigh',
    cursorVersion: '',
  }) + '\n');
  assert.deepEqual(readCursorUsageEvents(path), []);
});

test('hermes rows: enriched columns map (git repo root wins over cwd; title/branch kept)', () => {
  const events = hermesRowsToEvents([{
    id: 'hs-1', source: 'tui', model: 'hermes-4-405b',
    input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 0,
    reasoning_tokens: 5, actual_cost_usd: 0.02, billing_provider: 'nous',
    cwd: '/tmp/somewhere-deep/sub', git_repo_root: '/Users/x/myrepo', git_branch: 'main',
    title: 'Fix the flaky test', api_call_count: 7,
    started_at: 1783700000, ended_at: 1783700600, parent_session_id: null,
  }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].cwd, '/Users/x/myrepo');
  assert.equal(events[0].sessionTitle, 'Fix the flaky test');
  assert.equal(events[0].apiCallCount, 7);
  assert.equal(events[0].gitBranch, 'main');
  // Older schema rows (no enriched columns) still map cleanly.
  const old = hermesRowsToEvents([{
    id: 'hs-2', source: 'cli', model: 'hermes-4-405b',
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0,
    started_at: 1783700000, ended_at: 1783700100, cwd: '/x',
  }]);
  assert.equal(old[0].cwd, '/x');
  assert.ok(!('sessionTitle' in old[0]));
});

test('cursor csv: v1/v2/v3 headers parse; disjoint buckets; billed cost kept', () => {
  const v1 = [
    'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you',
    '2026-07-01T10:00:00Z,claude-sonnet-5,5000,3000,40000,1200,49200,$0.50,$0.25',
    '2026-07-01T11:00:00Z,gpt-5.6-terra,100,100,0,50,250,Included,-',
  ].join('\n');
  const r1 = parseCursorUsageCsv(v1);
  assert.equal(r1.length, 2);
  assert.equal(r1[0].inputTokens, 3000);              // w/o cache write
  assert.equal(r1[0].cacheCreationTokens, 2000);      // w/ minus w/o
  assert.equal(r1[0].cachedTokens, 40000);
  assert.equal(r1[0].totalCost, 0.25);                // "Cost to you" preferred
  assert.ok(!('totalCost' in r1[1]));                 // "Included" → estimated later

  const v2 = [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '2026-07-02T09:00:00Z,chat,claude-opus-4-8,false,900,800,10000,300,12000,$1.10',
  ].join('\n');
  const r2 = parseCursorUsageCsv(v2);
  assert.equal(r2[0].model, 'claude-opus-4-8');
  assert.equal(r2[0].totalCost, 1.10);

  const v3 = [
    'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '2026-07-03T09:00:00Z,,,"chat","gpt-5.6-sol",false,50,50,0,20,120,$0.03',
  ].join('\n');
  const r3 = parseCursorUsageCsv(v3);
  assert.equal(r3[0].model, 'gpt-5.6-sol');
  assert.equal(r3[0].totalCost, 0.03);

  // Junk tolerance
  assert.deepEqual(parseCursorUsageCsv(''), []);
  assert.deepEqual(parseCursorUsageCsv('not,a,cursor,csv\n1,2,3,4'), []);
  const badRow = parseCursorUsageCsv(v1.split('\n')[0] + '\nnot-a-date,m,1,1,0,1,3,$0,$0');
  assert.deepEqual(badRow, []);
});

test('cursor csv: records flow through the reader with import source + stable ids', () => {
  const rows = parseCursorUsageCsv([
    'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you',
    '2026-07-01T10:00:00Z,claude-sonnet-5,5000,3000,40000,1200,49200,$0.50,$0.25',
  ].join('\n'));
  const path = tmpFile('cursor-import.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const events = readCursorUsageEvents(path);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'cursor-csv-import');
  assert.equal(events[0].totalCost, 0.25);
  assert.ok(events[0].externalId.startsWith('cursor:csv-'));
});
