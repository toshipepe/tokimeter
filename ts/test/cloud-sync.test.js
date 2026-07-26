import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkCloudEvents,
  clearCloudPause,
  cloudPauseActive,
  cloudPauseState,
  cloudResponseResult,
  eventToCloudPayload,
  hashedSessionId,
  projectForCloud,
  stableCloudEventId,
} from '../packages/proxy/src/cloud-sync.js';

test('cloud sync: metadata allowlist drops prompts, responses, account data, and full paths', () => {
  const event = {
    externalId: 'turn-1',
    timestamp: 1_700_000_000_000,
    provider: 'openai',
    model: 'gpt-test',
    tool: 'cline',
    inputTokens: 123,
    outputTokens: 45,
    cachedTokens: 20,
    cacheCreationTokens: 3,
    reasoningTokens: 4,
    totalCost: 0.12,
    project: '/Users/private/Desktop/secret-client',
    sessionId: 'raw-session-secret',
    prompt: 'never upload this prompt',
    response: 'never upload this response',
    email: 'person@example.com',
  };
  const payload = eventToCloudPayload(event);
  const encoded = JSON.stringify(payload);
  assert.equal(payload.project, 'secret-client');
  assert.match(payload.session_id, /^s_[a-f0-9]{32}$/);
  assert.equal(payload.input_tokens, 123);
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.cache_creation_tokens, 3);
  assert.doesNotMatch(encoded, /never upload|person@example|\/Users\/private|raw-session-secret/);
});

test('cloud sync: project privacy supports basename, off, and explicit full modes', () => {
  assert.equal(projectForCloud('C:\\work\\acme', 'basename'), 'acme');
  assert.equal(projectForCloud('/work/acme', 'off'), null);
  assert.equal(projectForCloud('/work/acme', 'full'), '/work/acme');
});

test('cloud sync: event and session identifiers are stable without revealing raw sessions', () => {
  const event = { timestamp: 1000, tool: 'codex', provider: 'openai', model: 'gpt', inputTokens: 2 };
  assert.equal(stableCloudEventId(event), stableCloudEventId({ ...event }));
  assert.equal(hashedSessionId('session-a'), hashedSessionId('session-a'));
  assert.notEqual(hashedSessionId('session-a'), hashedSessionId('session-b'));
});

test('cloud sync: batches never exceed the backend maximum', () => {
  const chunks = chunkCloudEvents(Array.from({ length: 501 }, (_, i) => i), 999);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [250, 250, 1]);
});

test('cloud sync: trial expiry becomes a durable pause instead of a retryable failure', () => {
  const result = cloudResponseResult(402, {
    code: 'trial_expired',
    error: 'Your trial ended. Local tracking still works.',
    data_expires_at: '2026-08-22T00:00:00Z',
  });
  assert.equal(result.ok, false);
  assert.equal(result.accessPaused, true);
  const paused = cloudPauseState({ lastSuccessAt: 10 }, result, 1000, 5000);
  assert.equal(cloudPauseActive(paused, 5999), true);
  assert.equal(cloudPauseActive(paused, 6000), false);
  assert.equal(paused.lastSuccessAt, 10);
  assert.equal(paused.dataExpiresAt, '2026-08-22T00:00:00Z');
  assert.equal(clearCloudPause(paused).accessPaused, false);
  assert.equal(clearCloudPause(paused).pauseCode, undefined);
});

test('cloud sync: unrelated payment-required responses are not treated as a trial pause', () => {
  assert.equal(cloudResponseResult(402, { code: 'card_required' }).accessPaused, false);
  assert.equal(cloudResponseResult(503, { code: 'entitlement_unavailable' }).accessPaused, false);
});

test('cloud sync: a deleted or revoked device key is terminal and does not enter the retry queue', () => {
  const result = cloudResponseResult(401, { error: 'Invalid or revoked API key' });
  assert.equal(result.accessPaused, false);
  assert.equal(result.terminalFailure, true);
  assert.equal(result.code, 'device_key_invalid');
});
