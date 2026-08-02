import { createHash } from 'node:crypto';

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pathTail(value) {
  const parts = String(value || '').trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function projectForCloud(project, mode = 'basename') {
  const value = String(project || '').trim();
  if (!value || mode === 'off') return null;
  if (mode === 'full') return value.slice(0, 500);
  return pathTail(value).slice(0, 160) || null;
}

export function hashedSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!value) return null;
  return `s_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function stableCloudEventId(event) {
  const explicit = String(event?.externalId || '').trim();
  if (explicit) return explicit.slice(0, 500);
  const identity = JSON.stringify([
    Number(event?.timestamp) || 0,
    String(event?.tool || ''),
    String(event?.provider || ''),
    String(event?.model || ''),
    String(event?.project || ''),
    String(event?.sessionId || ''),
    String(event?.source || ''),
    nonNegativeNumber(event?.inputTokens),
    nonNegativeNumber(event?.outputTokens),
    nonNegativeNumber(event?.cachedTokens),
    nonNegativeNumber(event?.totalCost),
  ]);
  return `local_${createHash('sha256').update(identity).digest('hex')}`;
}

export function eventToCloudPayload(event, { projectMode = 'basename' } = {}) {
  const timestamp = Number(event?.timestamp) || Date.now();
  const timestampSeconds = timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp;
  const project = projectForCloud(event?.project, projectMode);
  const sessionId = hashedSessionId(event?.sessionId);

  const payload = {
    contract_version: 1,
    external_id: stableCloudEventId(event),
    provider: String(event?.provider || 'unknown').slice(0, 120),
    model: String(event?.model || 'unknown').slice(0, 240),
    input_tokens: Math.floor(nonNegativeNumber(event?.inputTokens)),
    output_tokens: Math.floor(nonNegativeNumber(event?.outputTokens)),
    cached_tokens: Math.floor(nonNegativeNumber(event?.cachedTokens)),
    cache_creation_tokens: Math.floor(nonNegativeNumber(event?.cacheCreationTokens)),
    reasoning_tokens: Math.floor(nonNegativeNumber(event?.reasoningTokens)),
    input_cost: nonNegativeNumber(event?.inputCost),
    output_cost: nonNegativeNumber(event?.outputCost),
    total_cost: nonNegativeNumber(event?.totalCost),
    latency_ms: Math.floor(nonNegativeNumber(event?.latencyMs)),
    success: event?.success !== false,
    confidence: String(event?.confidence || 'tracked').slice(0, 80),
    effort: event?.effort == null ? null : String(event.effort).slice(0, 80),
    tool: String(event?.tool || 'unknown').slice(0, 120),
    source: String(event?.source || 'tokimeter-local-reader').slice(0, 120),
    timestamp: timestampSeconds,
  };
  if (project) payload.project = project;
  if (sessionId) payload.session_id = sessionId;
  return payload;
}

export function chunkCloudEvents(events, size = 200) {
  const width = Math.max(1, Math.min(250, Math.floor(Number(size) || 200)));
  const chunks = [];
  for (let i = 0; i < events.length; i += width) chunks.push(events.slice(i, i + width));
  return chunks;
}

export function newestFirstCloudEvents(events) {
  return Array.from(events || []).sort(
    (left, right) => (Number(right?.timestamp) || 0) - (Number(left?.timestamp) || 0),
  );
}

export async function sendCloudBatchWithRetry(send, {
  maxQuotaRetries = 0,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onQuotaWait = null,
} = {}) {
  let quotaRetries = 0;
  while (true) {
    try {
      return await send();
    } catch (error) {
      const rateLimited = error?.rateLimited === true || Number(error?.status) === 429;
      if (!rateLimited || quotaRetries >= maxQuotaRetries) throw error;
      quotaRetries += 1;
      const requestedWait = Number(error?.retryAfterMs);
      const waitMs = Math.max(
        1000,
        Math.min(120000, Number.isFinite(requestedWait) && requestedWait > 0 ? requestedWait : 61000),
      );
      if (typeof onQuotaWait === 'function') onQuotaWait(waitMs, quotaRetries);
      await wait(waitMs);
    }
  }
}

export function cloudResponseResult(status, payload = {}) {
  const numericStatus = Number(status) || 0;
  const rateLimited = numericStatus === 429;
  const code = String(payload?.code || (numericStatus === 401 ? 'device_key_invalid' : rateLimited ? 'ingest_rate_limited' : ''));
  const accessPaused = Number(status) === 402 && ['trial_expired', 'upgrade_required'].includes(code);
  const terminalFailure = accessPaused || numericStatus === 401;
  const retryAfterSeconds = Number(payload?.retry_after_seconds);
  return {
    ok: numericStatus >= 200 && numericStatus < 300,
    status: numericStatus,
    code,
    error: String(payload?.error || ''),
    accessPaused,
    terminalFailure,
    rateLimited,
    retryAfterMs: rateLimited
      ? Math.max(1000, (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 61) * 1000)
      : 0,
    dataExpiresAt: payload?.data_expires_at || null,
    cloudDataDeletedAt: payload?.cloud_data_deleted_at || null,
    upgradeUrl: payload?.upgrade_url || 'https://tokimeter.com/app/',
  };
}

export function cloudPauseActive(state, now = Date.now()) {
  return state?.accessPaused === true && Number(state?.nextEntitlementCheckAt || 0) > now;
}

export function cloudPauseState(current, result, now = Date.now(), retryMs = 24 * 60 * 60 * 1000) {
  // An invalid/revoked key cannot recover by retrying. Keep background sync
  // dormant until a manual sync probe or a fresh device connection rewrites
  // the local state. Trial expiry still gets one low-cost daily recheck.
  const waitMs = result.code === 'device_key_invalid' ? 100 * 365 * 24 * 60 * 60 * 1000 : retryMs;
  return {
    ...(current || {}),
    accessPaused: true,
    pauseCode: result.code || 'upgrade_required',
    pauseMessage: result.error || 'Cloud access is paused. Local Tokimeter tracking still works.',
    dataExpiresAt: result.dataExpiresAt || null,
    cloudDataDeletedAt: result.cloudDataDeletedAt || null,
    upgradeUrl: result.upgradeUrl || 'https://tokimeter.com/app/',
    pausedAt: current?.pausedAt || now,
    nextEntitlementCheckAt: now + waitMs,
  };
}

export function clearCloudPause(state) {
  const next = { ...(state || {}), accessPaused: false };
  for (const key of [
    'pauseCode', 'pauseMessage', 'dataExpiresAt', 'cloudDataDeletedAt',
    'upgradeUrl', 'pausedAt', 'nextEntitlementCheckAt',
  ]) delete next[key];
  return next;
}
