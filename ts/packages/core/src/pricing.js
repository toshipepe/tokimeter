/**
 * Tokimeter Core — Pricing Database
 *
 * Prices per 1M tokens for all major LLM providers.
 * Same data as the Python SDK, kept in sync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ModelPrice
 * @property {string} provider   - "openai", "anthropic", "google", etc.
 * @property {string} model      - canonical model name
 * @property {number} input      - USD per 1M input tokens
 * @property {number} output     - USD per 1M output tokens
 * @property {number} cached     - USD per 1M cache-read input tokens (0 if N/A)
 * @property {number} [cacheWrite] - USD per 1M cache-write/creation input tokens (defaults to 1.25x input when tokens are reported)
 * @property {string[]} aliases  - alternative names that map to this model
 * @property {boolean} [custom] - user-supplied local price
 * @property {boolean} [feed] - community-feed price
 * @property {{ peakUtcHours: number[][], peak: { input: number, output: number, cached: number } }} [timeRates]
 */

// ─── Prices ─────────────────────────────────────────────────────────────────

/** @type {ModelPrice[]} */
const PRICES = [
  // ─── OpenAI ───────────────────────────────────────────────────────────────
  // Verified against developers.openai.com/api/docs/pricing, 2026-08-21.
  // 5.6+ publishes explicit cache-write pricing at 1.25x input. o1-mini is no
  // longer listed and is kept at its last published rate for older usage.
  { provider: "openai", model: "gpt-5.6-sol",       input: 5.00,  output: 30.00, cached: 0.50,  cacheWrite: 6.25 },
  { provider: "openai", model: "gpt-5.6-terra",     input: 2.00,  output: 12.00, cached: 0.20,  cacheWrite: 2.50 },
  { provider: "openai", model: "gpt-5.6-luna",      input: 0.20,  output: 1.20,  cached: 0.02,  cacheWrite: 0.25 },
  { provider: "openai", model: "gpt-5.5",           input: 5.00,  output: 30.00, cached: 0.50 },
  { provider: "openai", model: "gpt-5.4",           input: 2.50,  output: 15.00, cached: 0.25 },
  { provider: "openai", model: "gpt-5.4-mini",      input: 0.75,  output: 4.50,  cached: 0.075 },
  { provider: "openai", model: "gpt-5.3-codex",     input: 1.75,  output: 14.00, cached: 0.175 },
  { provider: "openai", model: "gpt-4o",            input: 2.50,  output: 10.00, cached: 1.25,
    aliases: ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20"] },
  { provider: "openai", model: "gpt-4o-mini",       input: 0.15,  output: 0.60,  cached: 0.075,
    aliases: ["gpt-4o-mini-2024-07-18"] },
  { provider: "openai", model: "gpt-4.1",           input: 2.00,  output: 8.00,  cached: 0.50 },
  { provider: "openai", model: "gpt-4.1-mini",      input: 0.40,  output: 1.60,  cached: 0.10 },
  { provider: "openai", model: "gpt-4.1-nano",      input: 0.10,  output: 0.40,  cached: 0.025 },
  { provider: "openai", model: "o1",               input: 15.00, output: 60.00, cached: 7.50 },
  { provider: "openai", model: "o1-mini",          input: 1.10,  output: 4.40,  cached: 0.55 },
  { provider: "openai", model: "o3",               input: 2.00,  output: 8.00,  cached: 0.50 },
  { provider: "openai", model: "o3-mini",          input: 1.10,  output: 4.40,  cached: 0.55 },
  { provider: "openai", model: "o4-mini",          input: 1.10,  output: 4.40,  cached: 0.275 },
  { provider: "openai", model: "gpt-4-turbo",      input: 10.00, output: 30.00, cached: 0 },
  { provider: "openai", model: "gpt-3.5-turbo",    input: 0.50,  output: 1.50,  cached: 0 },

  // ─── Anthropic ────────────────────────────────────────────────────────────
  // Verified against platform.claude.com pricing, 2026-08-21.
  // cached = cache-read rate (~0.1x input); cacheWrite = 5-minute-TTL cache-write rate (~1.25x input).
  { provider: "anthropic", model: "claude-fable-5",          input: 10.00, output: 50.00, cached: 1.00, cacheWrite: 12.50,
    aliases: ["claude-mythos-5"] },
  { provider: "anthropic", model: "claude-opus-5",           input: 5.00,  output: 25.00, cached: 0.50, cacheWrite: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-8",         input: 5.00,  output: 25.00, cached: 0.50, cacheWrite: 6.25,
    aliases: ["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-5-20251101"] },
  // Sonnet 5 sticker price is $3/$15; introductory $2/$10 applies through 2026-08-31 — using intro
  // rates now so tracked spend matches actual billing. Revert to 3.00/15.00 after 2026-08-31.
  { provider: "anthropic", model: "claude-sonnet-5",         input: 2.00,  output: 10.00, cached: 0.20, cacheWrite: 2.50 },
  { provider: "anthropic", model: "claude-sonnet-4-6",       input: 3.00,  output: 15.00, cached: 0.30, cacheWrite: 3.75,
    aliases: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"] },
  { provider: "anthropic", model: "claude-haiku-4-5",        input: 1.00,  output: 5.00,  cached: 0.10, cacheWrite: 1.25,
    aliases: ["claude-haiku-4-5-20251001"] },
  // Legacy entries kept for older tracked usage.
  { provider: "anthropic", model: "claude-opus-4",          input: 15.00, output: 75.00, cached: 1.50,
    aliases: ["claude-opus-4-20250918"] },
  { provider: "anthropic", model: "claude-sonnet-4",         input: 3.00,  output: 15.00, cached: 0.30,
    aliases: ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"] },
  { provider: "anthropic", model: "claude-haiku-4",          input: 0.80,  output: 4.00,  cached: 0.08,
    aliases: ["claude-haiku-4-20250414", "claude-3-5-haiku"] },
  { provider: "anthropic", model: "claude-3-opus",           input: 15.00, output: 75.00, cached: 0 },
  { provider: "anthropic", model: "claude-3-haiku",          input: 0.25,  output: 1.25,  cached: 0 },

  // ─── Google Gemini ────────────────────────────────────────────────────────
  // Verified against ai.google.dev/gemini-api/docs/pricing, 2026-08-21, at the
  // short-context (<=200k) text tier, matching the convention used for OpenAI
  // above. Gemini prices audio input and >200k context higher; Tokimeter does
  // not model those tiers, so long-context and audio usage is under-valued
  // rather than guessed.
  // Introductory rates apply through 2026-12-31; a dated CI guard prevents
  // them from silently surviving the change to $1.50/$7.50 on 2027-01-01.
  { provider: "google", model: "gemini-3.6-flash",        input: 0.75,  output: 3.75,  cached: 0.075 },
  { provider: "google", model: "gemini-3.5-flash",        input: 1.50,  output: 9.00,  cached: 0.15,
    aliases: ["gemini-3-flash"] },
  { provider: "google", model: "gemini-3.5-flash-lite",   input: 0.30,  output: 2.50,  cached: 0.03,
    aliases: ["gemini-3-flash-lite"] },
  { provider: "google", model: "gemini-3.1-flash-lite",   input: 0.25,  output: 1.50,  cached: 0.025 },
  { provider: "google", model: "gemini-3.1-pro-preview",  input: 2.00,  output: 12.00, cached: 0.20,
    aliases: ["gemini-3-pro", "gemini-3.5-pro"] },
  { provider: "google", model: "gemini-2.5-pro",          input: 1.25,  output: 10.00, cached: 0.125 },
  { provider: "google", model: "gemini-2.5-flash",        input: 0.30,  output: 2.50,  cached: 0.03 },
  { provider: "google", model: "gemini-2.5-flash-lite",   input: 0.10,  output: 0.40,  cached: 0.01 },

  // ─── Mistral ──────────────────────────────────────────────────────────────
  // Verified against mistral.ai/pricing/api, 2026-08-21. The floating -latest
  // aliases resolve to the current generation, so they are priced against it.
  // Mistral publishes cache-read at a 90% discount on input.
  { provider: "mistral", model: "mistral-large-3",        input: 0.50, output: 1.50, cached: 0.05,
    aliases: ["mistral-large-latest"] },
  { provider: "mistral", model: "mistral-medium-3.5",     input: 1.50, output: 7.50, cached: 0.15,
    aliases: ["mistral-medium-latest"] },
  { provider: "mistral", model: "mistral-small-4",        input: 0.15, output: 0.60, cached: 0.015,
    aliases: ["mistral-small-latest"] },
  { provider: "mistral", model: "ministral-3-3b",         input: 0.10, output: 0.10, cached: 0.01 },
  { provider: "mistral", model: "ministral-3-8b",         input: 0.15, output: 0.15, cached: 0.015 },
  { provider: "mistral", model: "ministral-3-14b",        input: 0.20, output: 0.20, cached: 0.02 },
  { provider: "mistral", model: "codestral",              input: 0.30, output: 0.90, cached: 0.03,
    aliases: ["codestral-latest"] },

  // ─── Meta Llama ───────────────────────────────────────────────────────────
  // Intentionally unpriced. Meta publishes no generally available first-party
  // API pricing; its direct Llama API remains waitlisted. Llama rates come from
  // third-party hosts such as DeepInfra, Groq, and Together, differ between
  // them, and move over time, so no single rate can be sourced as "the" Llama
  // price. Llama usage therefore stays outside priced totals as an unknown
  // model, which is the same treatment every other unsourced model gets. Add a
  // custom price for the host you actually use:
  //   tokimeter pricing set llama-4-maverick --input <in> --output <out>

  // ─── xAI Grok ─────────────────────────────────────────────────────────────
  // Verified against docs.x.ai models pricing, 2026-08-21, at the <200k tier.
  // xAI publishes explicit cache-read rates; they were previously recorded as
  // unpriced. Models below grok-4.3 are no longer listed and keep their last
  // published rates for older tracked usage.
  // grok-build: docs.x.ai Code API pricing; the Grok
  // Build CLI reports the model as grok-build / grok-build-b, API id is
  // grok-build-0.1. No cached-input price published → cached tokens free.
  { provider: "xai", model: "grok-build",        input: 1.00, output: 2.00,  cached: 0.20,
    aliases: ["grok-build-0.1", "grok-build-b"] },
  { provider: "xai", model: "grok-4.6",          input: 2.00, output: 6.00,  cached: 0.50,
    aliases: ["grok-4.6-latest"] },
  // grok-4.5: docs.x.ai flagship (verified 2026-07-11); $2/$6, 500k context,
  // no cached-input price published → cached tokens free.
  { provider: "xai", model: "grok-4.5",          input: 2.00, output: 6.00,  cached: 0.30,
    aliases: ["grok-4.5-latest"] },
  // grok-4.3: docs.x.ai Chat API pricing (verified 2026-07-08).
  { provider: "xai", model: "grok-4.3",          input: 1.25, output: 2.50,  cached: 0.20 },
  // Composer 2.5 fast variant runs inside Grok Build as
  // grok-composer-2.5-fast; $3/$15 per cursor.com/blog/composer-2-5
  // (verified 2026-07-08). No cached price published for the fast tier.
  { provider: "xai", model: "grok-composer-2.5-fast", input: 3.00, output: 15.00, cached: 0,
    aliases: ["composer-2.5-fast"] },
  { provider: "xai", model: "grok-4",            input: 5.00, output: 15.00, cached: 0 },
  { provider: "xai", model: "grok-4-fast",       input: 0.20, output: 0.50,  cached: 0 },
  { provider: "xai", model: "grok-3",            input: 3.00, output: 15.00, cached: 0 },
  { provider: "xai", model: "grok-3-mini",       input: 0.30, output: 0.50,  cached: 0 },
  { provider: "xai", model: "grok-2",            input: 2.00, output: 10.00, cached: 0 },

  // ─── DeepSeek ─────────────────────────────────────────────────────────────
  // Verified against api-docs.deepseek.com/quick_start/pricing, 2026-08-21.
  // Base fields are off-peak. priceCall selects the published 2x peak tier
  // for calls from 01:00-04:00 and 06:00-10:00 UTC using the event timestamp.
  { provider: "deepseek", model: "deepseek-v4-flash", input: 0.22, output: 0.66, cached: 0.007,
    timeRates: { peakUtcHours: [[1, 4], [6, 10]], peak: { input: 0.44, output: 1.32, cached: 0.014 } } },
  { provider: "deepseek", model: "deepseek-v4-pro", input: 0.66, output: 1.98, cached: 0.022,
    timeRates: { peakUtcHours: [[1, 4], [6, 10]], peak: { input: 1.32, output: 3.96, cached: 0.044 } } },

  // ─── Cursor ───────────────────────────────────────────────────────────────
  // Composer 2.5 standard tier per cursor.com/docs/models-and-pricing
  // (verified 2026-07-08). The fast tier lives in the xai block as
  // grok-composer-2.5-fast.
  { provider: "cursor", model: "composer-2.5", input: 0.50, output: 2.50, cached: 0.20 },

  // ─── Z.AI (GLM) ───────────────────────────────────────────────────────────
  // Current text-model rates verified against docs.z.ai pricing, 2026-08-21.
  // Cursor pricing docs list Composer 2.5 standard
  // separately; see the xai block for the fast tier used by Grok Build.
  { provider: "zai", model: "glm-5.2",       input: 1.40, output: 4.40, cached: 0.26 },
  { provider: "zai", model: "glm-5.3",       input: 1.40, output: 4.40, cached: 0.26 },
  { provider: "zai", model: "glm-5.1",       input: 1.40, output: 4.40, cached: 0.26 },
  { provider: "zai", model: "glm-5",         input: 1.00, output: 3.20, cached: 0.20 },
  { provider: "zai", model: "glm-5-turbo",   input: 1.20, output: 4.00, cached: 0.24 },
  { provider: "zai", model: "glm-4.7",       input: 0.60, output: 2.20, cached: 0.11 },
  { provider: "zai", model: "glm-4.7-flashx", input: 0.07, output: 0.40, cached: 0.01 },
  { provider: "zai", model: "glm-4.6",       input: 0.60, output: 2.20, cached: 0.11 },
  { provider: "zai", model: "glm-4.5",       input: 0.60, output: 2.20, cached: 0.11 },
  { provider: "zai", model: "glm-4.5-x",     input: 2.20, output: 8.90, cached: 0.45 },
  { provider: "zai", model: "glm-4.5-air",   input: 0.20, output: 1.10, cached: 0.03 },
  { provider: "zai", model: "glm-4.5-airx",  input: 1.10, output: 4.50, cached: 0.22 },
  { provider: "zai", model: "glm-4-32b-0414-128k", input: 0.10, output: 0.10, cached: 0 },
  { provider: "zai", model: "glm-4.7-flash", input: 0, output: 0, cached: 0 },
  { provider: "zai", model: "glm-4.5-flash", input: 0, output: 0, cached: 0 },
  { provider: "zai", model: "glm-5-plus",    input: 0.70, output: 2.80, cached: 0 },
  { provider: "zai", model: "glm-5-air",     input: 0.10, output: 0.40, cached: 0 },
  { provider: "zai", model: "glm-5-flash",   input: 0.10, output: 0.10, cached: 0 },
  { provider: "zai", model: "glm-4-plus",    input: 0.50, output: 1.50, cached: 0 },
  { provider: "zai", model: "glm-4-flash",   input: 0.01, output: 0.01, cached: 0 },
];

// ─── Lookup Map ─────────────────────────────────────────────────────────────

const CUSTOM_PRICING_FILE = process.env.TOKIMETER_PRICING_FILE || join(homedir(), '.tokimeter', 'pricing.json');
const PRICING_FEED_FILE = process.env.TOKIMETER_PRICING_FEED_FILE || join(homedir(), '.tokimeter', 'pricing-feed.json');
const PRICING_FEED_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FEED_PROVIDERS = { openai: 'openai', anthropic: 'anthropic', gemini: 'google', xai: 'xai', deepseek: 'deepseek', mistral: 'mistral' };
const KNOWN_INTERNAL_UNPRICED = new Map([
  ['codex-auto-review', {
    provider: 'openai',
    reason: 'OpenAI identifies this as Codex’s internal automatic approval reviewer but does not publish a stable per-token price or billable model mapping.',
  }],
]);

function knownInternalUnpriced(model) {
  const exact = KNOWN_INTERNAL_UNPRICED.get(model);
  if (exact) return exact;
  if (!model.includes('/')) return null;
  return KNOWN_INTERNAL_UNPRICED.get(model.slice(model.lastIndexOf('/') + 1)) || null;
}

const CUSTOM_PRICES = loadCustomPrices();
const FEED_PRICES = loadFeedPrices();
// Precedence: custom overrides > verified built-in table > community feed.
const ALL_PRICES = mergePrices(mergePrices(FEED_PRICES, PRICES), CUSTOM_PRICES);

/** Build a fast lookup map including all aliases */
const LOOKUP = new Map();
for (const p of ALL_PRICES) {
  registerPrice(p);
}

// ─── Cheaper Alternative Models ─────────────────────────────────────────────

/**
 * Maps expensive models to cheaper alternatives.
 * quality = expected quality retention (0-1)
 */
const DOWNGRADES = {
  "gpt-5.6-sol":        [{ model: "gpt-5.6-terra", quality: 0.95 }, { model: "gpt-5.6-luna", quality: 0.85 }],
  "gpt-5.6-terra":      [{ model: "gpt-5.6-luna", quality: 0.9 }],
  "gpt-5.5":            [{ model: "gpt-5.4", quality: 0.95 }, { model: "gpt-5.4-mini", quality: 0.85 }],
  "gpt-5.4":            [{ model: "gpt-5.4-mini", quality: 0.9 }],
  "claude-fable-5":     [{ model: "claude-opus-4-8", quality: 0.97 }, { model: "claude-sonnet-5", quality: 0.9 }],
  "claude-opus-4-8":    [{ model: "claude-sonnet-5", quality: 0.95 }, { model: "claude-haiku-4-5", quality: 0.85 }],
  "claude-sonnet-5":    [{ model: "claude-haiku-4-5", quality: 0.88 }],
  "claude-sonnet-4-6":  [{ model: "claude-haiku-4-5", quality: 0.88 }],
  "gpt-4o":            [{ model: "gpt-4o-mini", quality: 0.95 }, { model: "gpt-4.1-nano", quality: 0.85 }],
  "gpt-4.1":           [{ model: "gpt-4.1-mini", quality: 0.95 }],
  "o1":                [{ model: "o1-mini", quality: 0.90 }],
  "o3":                [{ model: "o3-mini", quality: 0.92 }],
  "claude-opus-4":     [{ model: "claude-sonnet-4", quality: 0.95 }, { model: "claude-haiku-4", quality: 0.85 }],
  "claude-sonnet-4":   [{ model: "claude-haiku-4", quality: 0.88 }],
  "gemini-2.5-pro":    [{ model: "gemini-2.5-flash", quality: 0.92 }],
  "gemini-3.1-pro-preview": [{ model: "gemini-3.5-flash", quality: 0.92 }],
  "grok-4.5":          [{ model: "grok-4-fast", quality: 0.9 }],
  "grok-4":            [{ model: "grok-4-fast", quality: 0.95 }],
  // deepseek-r1 -> deepseek-v3 and llama-3.1-405b -> llama-3.1-70b were dropped
  // with their prices. A downgrade to an unpriced model would produce a savings
  // number with nothing behind it.
  "mistral-medium-3.5": [{ model: "mistral-small-4", quality: 0.90 }],
};

// ─── Pricer ─────────────────────────────────────────────────────────────────

/**
 * Calculate cost for an LLM call.
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} cachedTokens - cache-read tokens
 * @param {number} cacheCreationTokens - cache-write tokens (Anthropic reports these separately)
 * @param {{ cachedIncludedInInput?: boolean, cacheCreationIncludedInInput?: boolean, timestamp?: number }} [options]
 *   Some ledgers report cache buckets as subsets of inputTokens. timestamp is
 *   used for providers such as DeepSeek whose published rate varies by UTC hour.
 * @returns {{
 *   inputCost: number,
 *   outputCost: number,
 *   totalCost: number,
 *   roughEstimateCost: number,
 *   price: ModelPrice | null,
 *   pricingSource: 'verified' | 'community' | 'custom' | 'fallback',
 *   authoritative: boolean
 * }}
 */
export function priceCall(model, inputTokens = 0, outputTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, {
  cachedIncludedInInput = true,
  cacheCreationIncludedInInput = false,
  timestamp = Date.now(),
} = {}) {
  const basePrice = lookupPrice(model);

  if (!basePrice) {
    // Unknown models are deliberately unpriced in authoritative totals. Keep
    // the old $2/$8 heuristic only as an explicitly separate rough estimate.
    const internal = knownInternalUnpriced(model);
    const roughInput = inputTokens + (cacheCreationIncludedInInput ? 0 : cacheCreationTokens);
    const inCost = (roughInput / 1_000_000) * 2.0;
    const outCost = (outputTokens / 1_000_000) * 8.0;
    return {
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      roughEstimateCost: round6(inCost + outCost),
      price: null,
      pricingSource: internal ? 'internal' : 'fallback',
      authoritative: false,
    };
  }

  const price = priceForTimestamp(basePrice, timestamp);
  const includedCache = (cachedIncludedInInput ? cachedTokens : 0)
    + (cacheCreationIncludedInInput ? cacheCreationTokens : 0);
  const billableInput = Math.max(0, inputTokens - includedCache);
  let inCost = (billableInput / 1_000_000) * price.input;

  if (cachedTokens > 0 && price.cached > 0) {
    inCost += (cachedTokens / 1_000_000) * price.cached;
  } else if (cachedTokens > 0) {
    inCost += (cachedTokens / 1_000_000) * price.input * 0.5;
  }

  if (cacheCreationTokens > 0) {
    const writeRate = price.cacheWrite > 0 ? price.cacheWrite : price.input * 1.25;
    inCost += (cacheCreationTokens / 1_000_000) * writeRate;
  }

  const outCost = (outputTokens / 1_000_000) * price.output;

  return {
    inputCost: round6(inCost),
    outputCost: round6(outCost),
    totalCost: round6(inCost + outCost),
    roughEstimateCost: 0,
    price,
    pricingSource: price.custom ? 'custom' : (price.feed ? 'community' : 'verified'),
    authoritative: true,
  };
}

function priceForTimestamp(price, timestamp) {
  const timeRates = price.timeRates;
  if (!timeRates?.peak || !Array.isArray(timeRates.peakUtcHours)) return price;
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return price;
  const hour = date.getUTCHours();
  const peak = timeRates.peakUtcHours.some(([start, end]) => hour >= start && hour < end);
  return peak ? { ...price, ...timeRates.peak, pricingTier: 'peak' } : price;
}

/**
 * Get the price object for a model.
 */
export function getPrice(model) {
  return lookupPrice(model);
}

function lookupPrice(model) {
  const exact = LOOKUP.get(model);
  if (exact) return exact;

  // Gateway-style ids (OpenRouter, LiteLLM) carry a provider prefix, e.g.
  // "anthropic/claude-sonnet-5" — match on the tail.
  if (model.includes('/')) {
    const tail = model.slice(model.lastIndexOf('/') + 1);
    const tailHit = LOOKUP.get(tail);
    if (tailHit) return tailHit;
    model = tail;
  }

  // Prefix matching for versioned names — prefer the longest (most specific) key.
  let best = null;
  let bestLen = 0;
  for (const [key, val] of LOOKUP) {
    if ((model.startsWith(key) || key.startsWith(model)) && key.length > bestLen) {
      best = val;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Explain where a model price came from.
 */
export function getPricingSource(model) {
  const price = getPrice(model);
  if (!price) {
    const internal = knownInternalUnpriced(model);
    if (internal) {
      return {
        confidence: 'fallback',
        source: 'internal',
        authoritative: false,
        file: CUSTOM_PRICING_FILE,
        model,
        provider: internal.provider,
        reason: internal.reason,
      };
    }
    return {
      confidence: 'fallback',
      source: 'fallback',
      authoritative: false,
      file: CUSTOM_PRICING_FILE,
    };
  }
  const source = price.custom ? 'custom' : (price.feed ? 'community' : 'built-in');
  return {
    confidence: price.custom ? 'custom' : (price.feed ? 'community' : 'verified'),
    source,
    authoritative: true,
    file: price.custom ? CUSTOM_PRICING_FILE : (price.feed ? PRICING_FEED_FILE : ''),
    model: price.model,
  };
}

/**
 * Add or update a local custom price.
 */
export function addCustomPrice(price) {
  const normalized = normalizePrice({ ...price, custom: true });
  const next = CUSTOM_PRICES.filter(p => p.model !== normalized.model);
  next.push(normalized);
  writeCustomPrices(next);
  registerPrice(normalized);
  return normalized;
}

/**
 * Get cheaper alternatives for a model.
 */
export function getDowngrades(model) {
  return DOWNGRADES[model] || [];
}

/**
 * List all known models.
 */
export function listModels(provider) {
  const seen = new Set();
  return ALL_PRICES.filter(p => {
    if (provider && p.provider !== provider) return false;
    if (seen.has(p.model)) return false;
    seen.add(p.model);
    return true;
  });
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Refresh the local pricing feed cache from the community-maintained LiteLLM
 * price table. Only called explicitly (tokimeter pricing refresh) — never on
 * the hot path. Filters to known providers and chat-style models to keep the
 * cache small.
 */
export async function refreshPricingFeed({ url = PRICING_FEED_URL } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Pricing feed HTTP ${response.status}`);
  const raw = await response.json();

  const prices = [];
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = FEED_PROVIDERS[entry.litellm_provider];
    if (!provider) continue;
    if (entry.mode && entry.mode !== 'chat' && entry.mode !== 'responses') continue;
    const input = Number(entry.input_cost_per_token) * 1e6;
    const output = Number(entry.output_cost_per_token) * 1e6;
    if (!(input > 0) || !(output > 0)) continue;
    const model = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    prices.push({
      provider,
      model,
      input: round6(input),
      output: round6(output),
      cached: round6(Math.max(0, Number(entry.cache_read_input_token_cost) * 1e6 || 0)),
      cacheWrite: round6(Math.max(0, Number(entry.cache_creation_input_token_cost) * 1e6 || 0)),
      aliases: [],
    });
  }

  mkdirSync(dirname(PRICING_FEED_FILE), { recursive: true });
  writeFileSync(PRICING_FEED_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), source: url, prices }) + '\n');
  return { count: prices.length, file: PRICING_FEED_FILE };
}

export function pricingFeedStatus() {
  try {
    if (!existsSync(PRICING_FEED_FILE)) return { exists: false };
    const data = JSON.parse(readFileSync(PRICING_FEED_FILE, 'utf8'));
    const fetchedAt = Date.parse(data.fetchedAt || '') || 0;
    return {
      exists: true,
      fetchedAt: data.fetchedAt || null,
      ageDays: fetchedAt ? Math.floor((Date.now() - fetchedAt) / 86400000) : null,
      count: Array.isArray(data.prices) ? data.prices.length : 0,
      file: PRICING_FEED_FILE,
    };
  } catch {
    return { exists: false };
  }
}

function loadFeedPrices() {
  try {
    if (!existsSync(PRICING_FEED_FILE)) return [];
    const data = JSON.parse(readFileSync(PRICING_FEED_FILE, 'utf8'));
    if (!Array.isArray(data.prices)) return [];
    return data.prices.map(p => normalizePrice({ ...p, feed: true })).filter(Boolean);
  } catch {
    return [];
  }
}

function loadCustomPrices() {
  try {
    if (!existsSync(CUSTOM_PRICING_FILE)) return [];
    const data = JSON.parse(readFileSync(CUSTOM_PRICING_FILE, 'utf8'));
    const prices = Array.isArray(data) ? data : data.prices;
    if (!Array.isArray(prices)) return [];
    return prices.map(p => normalizePrice({ ...p, custom: true })).filter(Boolean);
  } catch {
    return [];
  }
}

function writeCustomPrices(prices) {
  mkdirSync(dirname(CUSTOM_PRICING_FILE), { recursive: true });
  writeFileSync(CUSTOM_PRICING_FILE, JSON.stringify({ prices }, null, 2) + '\n');
}

function registerPrice(price) {
  if (!price) return;
  LOOKUP.set(price.model, price);
  for (const alias of (price.aliases || [])) {
    LOOKUP.set(alias, price);
  }
}

function mergePrices(builtIn, custom) {
  const byModel = new Map();
  for (const price of builtIn) byModel.set(price.model, normalizePrice(price));
  for (const price of custom) byModel.set(price.model, normalizePrice(price));
  return Array.from(byModel.values());
}

function normalizePrice(price) {
  if (!price || !price.model) return null;
  const peak = price.timeRates?.peak;
  const peakUtcHours = price.timeRates?.peakUtcHours;
  const timeRates = peak && Array.isArray(peakUtcHours)
    ? {
        peakUtcHours: peakUtcHours
          .filter((range) => Array.isArray(range) && range.length === 2)
          .map(([start, end]) => [Number(start), Number(end)]),
        peak: {
          input: Number(peak.input) || 0,
          output: Number(peak.output) || 0,
          cached: Number(peak.cached) || 0,
        },
      }
    : undefined;
  return {
    provider: String(price.provider || 'custom'),
    model: String(price.model),
    input: Number(price.input) || 0,
    output: Number(price.output) || 0,
    cached: Number(price.cached) || 0,
    cacheWrite: Number(price.cacheWrite) || 0,
    aliases: Array.isArray(price.aliases) ? price.aliases.map(String) : [],
    custom: Boolean(price.custom),
    feed: Boolean(price.feed),
    ...(timeRates ? { timeRates } : {}),
  };
}

export { ALL_PRICES, CUSTOM_PRICING_FILE, CUSTOM_PRICES, PRICES, DOWNGRADES };
