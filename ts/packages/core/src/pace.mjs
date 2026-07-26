// Pure pace-projection math for limit alerts (BUILD_PLAN 1.4).
//
// Plain ESM, no Deno/Supabase imports. This is the canonical copy in the public
// package (tested by ts/test/pace.test.js). The hosted limit-alerts Edge
// Function keeps its own self-contained copy so the two repos stay decoupled.
// Given a vendor rate-limit snapshot, project, under a constant-burn assumption,
// when usage would reach 100% of the window and whether that lands before reset.

export const WINDOW_MS = {
  '5h': 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// Don't alert below this — early in a window a high rate is common and noisy.
export const MIN_USED_PERCENT = 50;

// snapshot: { usedPercent, capturedAtMs, resetsAtMs, windowKind }
// Returns { shouldAlert, reason, projectedHitMs, elapsedFraction, ratePerFraction }.
// ratePerFraction is "percent consumed per full window" — > 100 means on pace
// to exhaust the window before it resets.
export function projectCap(snapshot, nowMs = Date.now()) {
  const L = WINDOW_MS[snapshot.windowKind];
  const { usedPercent, capturedAtMs, resetsAtMs } = snapshot;

  if (!L) return { shouldAlert: false, reason: 'unknown window' };
  if (!(resetsAtMs > nowMs)) return { shouldAlert: false, reason: 'window already reset' };
  if (!(usedPercent > 0)) return { shouldAlert: false, reason: 'no usage yet' };

  const windowStartMs = resetsAtMs - L;
  const elapsedFraction = (capturedAtMs - windowStartMs) / L;
  if (!(elapsedFraction > 0)) return { shouldAlert: false, reason: 'snapshot predates window' };

  // Constant burn: usage% ∝ elapsed fraction. Rate is %-per-full-window.
  const ratePerFraction = usedPercent / elapsedFraction;
  // Fraction of the window at which usage reaches 100% at this rate.
  const projectedHitFraction = 100 / ratePerFraction;
  const projectedHitMs = windowStartMs + L * projectedHitFraction;

  // On pace only if the 100% point lands before the window resets.
  const onPace = projectedHitFraction < 1;
  const shouldAlert = onPace && usedPercent >= MIN_USED_PERCENT;
  return {
    shouldAlert,
    reason: shouldAlert ? 'on pace to hit cap' : (onPace ? 'below alert threshold' : 'not on pace'),
    projectedHitMs,
    elapsedFraction,
    ratePerFraction,
  };
}
