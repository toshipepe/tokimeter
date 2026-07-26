/**
 * Tokimeter Core — Cost Tracker
 *
 * In-memory call tracking with running totals, per-agent/model breakdowns,
 * and tip generation. Used by both the proxy and the VS Code extension.
 */

import { priceCall, getPrice, getDowngrades } from './pricing.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TrackedCall
 * @property {number} timestamp
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedTokens
 * @property {number} totalCost
 * @property {number} latencyMs
 * @property {boolean} success
 * @property {string} tool  - "claude-code", "codex", "cursor", "aider", etc.
 */

/**
 * @typedef {Object} CostSummary
 * @property {number} totalCost
 * @property {number} totalCalls
 * @property {number} todayCost
 * @property {number} todayCalls
 * @property {Record<string, number>} byModel  - { model: cost }
 * @property {Record<string, number>} byTool   - { tool: cost }
 * @property {Record<string, number>} byDay    - { "YYYY-MM-DD": cost }
 */

// ─── Tracker ────────────────────────────────────────────────────────────────

export class CostTracker {
  constructor(maxHistory = 10000) {
    this.calls = [];
    this.maxHistory = maxHistory;
  }

  /**
   * Record a completed LLM call.
   * @param {TrackedCall} call
   */
  record(call) {
    this.calls.push(call);
    if (this.calls.length > this.maxHistory) {
      this.calls.shift();
    }
  }

  /**
   * Get a summary of all tracked costs.
   * @returns {CostSummary}
   */
  getSummary() {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    let totalCost = 0, totalCalls = 0;
    let todayCost = 0, todayCalls = 0;
    const byModel = {};
    const byTool = {};
    const byDay = {};

    for (const call of this.calls) {
      totalCost += call.totalCost;
      totalCalls++;

      byModel[call.model] = (byModel[call.model] || 0) + call.totalCost;
      byTool[call.tool] = (byTool[call.tool] || 0) + call.totalCost;

      const day = new Date(call.timestamp).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + call.totalCost;

      if (call.timestamp >= todayMs) {
        todayCost += call.totalCost;
        todayCalls++;
      }
    }

    return {
      totalCost: round4(totalCost),
      totalCalls,
      todayCost: round4(todayCost),
      todayCalls,
      byModel: roundDict(byModel),
      byTool: roundDict(byTool),
      byDay: roundDict(byDay),
    };
  }

  /**
   * Get today's call history (for the extension display).
   * @param {number} limit
   * @returns {TrackedCall[]}
   */
  getRecentCalls(limit = 50) {
    return this.calls.slice(-limit);
  }

  /**
   * Generate actionable cost-saving tips based on call history.
   * Returns a rotating list — call this each time to get a fresh tip.
   * @param {number} [seed] - optional seed for tip rotation
   * @returns {string[]}
   */
  getTips(seed = Date.now()) {
    const tips = [];

    if (this.calls.length === 0) {
      return ['💰 Tokimeter is active — your LLM costs will appear here.'];
    }

    const summary = this.getSummary();

    // ─── Downgrade opportunities ─────────────────────────────────────────
    const modelCallCounts = {};
    for (const call of this.calls) {
      modelCallCounts[call.model] = (modelCallCounts[call.model] || 0) + 1;
    }

    for (const [model, count] of Object.entries(modelCallCounts)) {
      if (count < 5) continue; // need at least 5 calls to suggest a downgrade

      const downgrades = getDowngrades(model);
      if (downgrades.length === 0) continue;

      const modelCost = summary.byModel[model] || 0;
      const best = downgrades[0];
      const bestPrice = getPrice(best.model);
      const currentPrice = getPrice(model);

      if (!bestPrice || !currentPrice) continue;

      // Calculate savings
      let modelInputTokens = 0, modelOutputTokens = 0;
      for (const call of this.calls) {
        if (call.model === model) {
          modelInputTokens += call.inputTokens;
          modelOutputTokens += call.outputTokens;
        }
      }

      const cheaperCost =
        (modelInputTokens / 1_000_000) * bestPrice.input +
        (modelOutputTokens / 1_000_000) * bestPrice.output;
      const savings = modelCost - cheaperCost;

      if (savings > 0.05) {
        const monthlySavings = savings * (30 / Math.max(this._getDaySpan(), 1));
        tips.push(
          `💡 ${count}x ${model} → ${best.model}: save ~$${round2(monthlySavings)}/mo (${Math.round(best.quality * 100)}% quality match)`
        );
      }
    }

    // ─── Expensive anomalies ─────────────────────────────────────────────
    if (this.calls.length >= 10) {
      const recentCalls = this.calls.slice(-20);
      const avgCost = recentCalls.reduce((s, c) => s + c.totalCost, 0) / recentCalls.length;
      const expensiveCalls = recentCalls.filter(c => c.totalCost > avgCost * 3 && c.totalCost > 0.005);

      if (expensiveCalls.length > 0) {
        tips.push(
          `⚠️ ${expensiveCalls.length} recent calls cost 3x your average ($${round4(avgCost)}) — check for oversized context`
        );
      }
    }

    // ─── Failed calls ────────────────────────────────────────────────────
    const failed = this.calls.filter(c => !c.success);
    if (failed.length >= 3) {
      const wasted = failed.reduce((s, c) => s + c.totalCost, 0);
      tips.push(`❌ ${failed.length} failed calls wasted $${round4(wasted)} — add retry logic`);
    }

    // ─── Simple spending summary ─────────────────────────────────────────
    if (tips.length === 0) {
      if (summary.todayCalls > 0) {
        tips.push(`💰 ${summary.todayCalls} calls today / $${summary.todayCost} — all efficient ✓`);
      } else {
        tips.push(`💰 ${summary.totalCalls} total calls tracked / $${summary.totalCost} lifetime`);
      }
    }

    return tips;
  }

  /**
   * Get a single rotating tip (cycles through available tips).
   */
  getRotatingTip() {
    const tips = this.getTips();
    const idx = Math.floor(Date.now() / 5000) % tips.length; // rotate every 5s
    return tips[idx];
  }

  /**
   * Get the number of days spanned by the call history.
   */
  _getDaySpan() {
    if (this.calls.length === 0) return 1;
    const first = this.calls[0].timestamp;
    const last = this.calls[this.calls.length - 1].timestamp;
    const days = (last - first) / 86400000;
    return Math.max(days, 1);
  }

  /**
   * Clear all history.
   */
  clear() {
    this.calls = [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function round6(n) { return Math.round(n * 1000000) / 1000000; }
function roundDict(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k] = round4(v);
  return out;
}
