import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCap, WINDOW_MS, MIN_USED_PERCENT } from '../packages/core/src/pace.mjs';

const HOUR = 3600 * 1000;

// Helper: a snapshot for a window that resets `resetsInMs` from `now`, captured
// `capturedAgoMs` before now, at `usedPercent`.
function snap(windowKind, usedPercent, elapsedFraction) {
  const now = 1_000_000_000_000;
  const L = WINDOW_MS[windowKind];
  const windowStart = now - L * elapsedFraction;
  return {
    now,
    snapshot: { usedPercent, windowKind, capturedAtMs: now, resetsAtMs: windowStart + L },
  };
}

test('pace: on pace when rate would exhaust the window before reset', () => {
  // Halfway through a 5h window, already at 80% → rate 160%/window → on pace.
  const { now, snapshot } = snap('5h', 80, 0.5);
  const r = projectCap(snapshot, now);
  assert.equal(r.shouldAlert, true);
  assert.ok(Math.abs(r.ratePerFraction - 160) < 1e-9);
  // Reaches 100% at fraction 100/160 = 0.625 of the window.
  const windowStart = snapshot.resetsAtMs - WINDOW_MS['5h'];
  assert.ok(Math.abs(r.projectedHitMs - (windowStart + WINDOW_MS['5h'] * 0.625)) < 1);
  assert.ok(r.projectedHitMs < snapshot.resetsAtMs);
});

test('pace: not on pace when usage tracks below the window rate', () => {
  // Halfway through, only 40% used → rate 80%/window → finishes under the cap.
  const { now, snapshot } = snap('weekly', 40, 0.5);
  const r = projectCap(snapshot, now);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'not on pace');
});

test('pace: on pace but below the used-percent floor does not alert', () => {
  // 5% into the window, already 40% used → rate 800%/window (on pace) but
  // usedPercent < MIN_USED_PERCENT, so it stays quiet (early-window noise).
  const { now, snapshot } = snap('5h', 40, 0.05);
  const r = projectCap(snapshot, now);
  assert.ok(40 < MIN_USED_PERCENT);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'below alert threshold');
});

test('pace: an already-reset window never alerts', () => {
  const now = 1_000_000_000_000;
  const r = projectCap({ usedPercent: 99, windowKind: '5h', capturedAtMs: now - HOUR, resetsAtMs: now - 1 }, now);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'window already reset');
});

test('pace: unknown window kind is ignored', () => {
  const now = 1_000_000_000_000;
  const r = projectCap({ usedPercent: 90, windowKind: 'daily', capturedAtMs: now, resetsAtMs: now + HOUR }, now);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'unknown window');
});
