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
  newestFirstCloudEvents,
  projectForCloud,
  sendCloudBatchWithRetry,
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
    providerRequestId: 'resp_provider_private_001',
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
  assert.doesNotMatch(
    encoded,
    /never upload|person@example|\/Users\/private|raw-session-secret|resp_provider_private_001/,
  );
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

test('cloud sync: reconnect backfills send newest metadata first', () => {
  const ordered = newestFirstCloudEvents([
    { externalId: 'oldest', timestamp: 100 },
    { externalId: 'newest', timestamp: 300 },
    { externalId: 'middle', timestamp: 200 },
  ]);
  assert.deepEqual(ordered.map((event) => event.externalId), ['newest', 'middle', 'oldest']);
});

test('cloud sync: a foreground quota response waits and resumes the same batch', async () => {
  let attempts = 0;
  const waits = [];
  const result = await sendCloudBatchWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('Ingest rate limit exceeded'), {
        status: 429,
        rateLimited: true,
        retryAfterMs: 1250,
      });
    }
    return { accepted: 3 };
  }, {
    maxQuotaRetries: 2,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, { accepted: 3 });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1250]);
});

test('cloud sync: background quota responses return promptly for the next scan', async () => {
  await assert.rejects(
    sendCloudBatchWithRetry(async () => {
      throw Object.assign(new Error('Ingest rate limit exceeded'), {
        status: 429,
        rateLimited: true,
        retryAfterMs: 60000,
      });
    }, { maxQuotaRetries: 0 }),
    /Ingest rate limit exceeded/,
  );
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

test('cloud sync: Tokimeter quota responses preserve the retry delay', () => {
  const result = cloudResponseResult(429, {
    code: 'ingest_rate_limited',
    error: 'Ingest rate limit exceeded',
    retry_after_seconds: 17,
  });
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 17000);
});

test('cloud sync: a deleted or revoked device key is terminal and does not enter the retry queue', () => {
  const result = cloudResponseResult(401, { error: 'Invalid or revoked API key' });
  assert.equal(result.accessPaused, false);
  assert.equal(result.terminalFailure, true);
  assert.equal(result.code, 'device_key_invalid');
});
