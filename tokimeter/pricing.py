"""
LLM pricing database — prices per 1M tokens for all major providers.

Sources: official provider pricing pages as of mid-2026.
Prices are USD per 1,000,000 tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass
class ModelPrice:
    """Pricing for a single model."""
    provider: str
    model: str           # canonical name
    input_per_1m: float  # USD per 1M input tokens
    output_per_1m: float # USD per 1M output tokens
    cached_input_per_1m: float = 0.0   # cache-read input price
    aliases: tuple = ()  # alternative names that map to this model
    cache_write_per_1m: float = 0.0    # cache-write/creation input price (0 = default 1.25x input)
    peak_utc_hours: tuple = ()         # half-open UTC hour ranges, e.g. ((1, 4), (6, 10))
    peak_input_per_1m: float = 0.0
    peak_output_per_1m: float = 0.0
    peak_cached_input_per_1m: float = 0.0


# ─── OpenAI ─────────────────────────────────────────────────────────────────

OPENAI_PRICES = [
    # Verified against developers.openai.com/api/docs/pricing, 2026-08-21.
    # 5.6+ publishes explicit cache-write pricing at 1.25x input. o1-mini is no
    # longer listed and keeps its last published rate for older usage.
    ModelPrice("openai", "gpt-5.6-sol",       5.00,  30.00, 0.50,  (), 6.25),
    ModelPrice("openai", "gpt-5.6-terra",     2.00,  12.00, 0.20,  (), 2.50),
    ModelPrice("openai", "gpt-5.6-luna",      0.20,   1.20, 0.02,  (), 0.25),
    ModelPrice("openai", "gpt-5.5",           5.00,  30.00, 0.50),
    ModelPrice("openai", "gpt-5.4",           2.50,  15.00, 0.25),
    ModelPrice("openai", "gpt-5.4-mini",      0.75,   4.50, 0.075),
    ModelPrice("openai", "gpt-5.3-codex",     1.75,  14.00, 0.175),
    ModelPrice("openai", "gpt-4o",            2.50,  10.00, 1.25,
               ("gpt-4o-2024-08-06", "gpt-4o-2024-11-20")),
    ModelPrice("openai", "gpt-4o-mini",       0.15,  0.60, 0.075,
               ("gpt-4o-mini-2024-07-18",)),
    ModelPrice("openai", "gpt-4.1",           2.00,  8.00, 0.50),
    ModelPrice("openai", "gpt-4.1-mini",      0.40,  1.60, 0.10),
    ModelPrice("openai", "gpt-4.1-nano",      0.10,  0.40, 0.025),
    ModelPrice("openai", "o1",               15.00,  60.00, 7.50),
    ModelPrice("openai", "o1-mini",           1.10,  4.40, 0.55),
    ModelPrice("openai", "o3",                2.00,  8.00, 0.50),
    ModelPrice("openai", "o3-mini",           1.10,  4.40, 0.55),
    ModelPrice("openai", "o4-mini",           1.10,  4.40, 0.275),
    ModelPrice("openai", "gpt-4-turbo",      10.00,  30.00),
    ModelPrice("openai", "gpt-3.5-turbo",     0.50,  1.50),
]

# ─── Anthropic ──────────────────────────────────────────────────────────────

ANTHROPIC_PRICES = [
    # Verified against platform.claude.com pricing, 2026-08-21.
    # cached = cache-read (~0.1x input); cache_write = 5-min-TTL cache-write (~1.25x input).
    ModelPrice("anthropic", "claude-fable-5",          10.00, 50.00, 1.00,
               ("claude-mythos-5",), 12.50),
    ModelPrice("anthropic", "claude-opus-5",            5.00, 25.00, 0.50, (), 6.25),
    ModelPrice("anthropic", "claude-opus-4-8",          5.00, 25.00, 0.50,
               ("claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
                "claude-opus-4-5-20251101"), 6.25),
    # Sonnet 5 sticker is $3/$15; introductory $2/$10 applies through 2026-08-31 —
    # using intro rates so tracked spend matches actual billing. Revert after 2026-08-31.
    ModelPrice("anthropic", "claude-sonnet-5",          2.00, 10.00, 0.20, (), 2.50),
    ModelPrice("anthropic", "claude-sonnet-4-6",        3.00, 15.00, 0.30,
               ("claude-sonnet-4-5", "claude-sonnet-4-5-20250929"), 3.75),
    ModelPrice("anthropic", "claude-haiku-4-5",         1.00,  5.00, 0.10,
               ("claude-haiku-4-5-20251001",), 1.25),
    # Legacy entries kept for older tracked usage.
    ModelPrice("anthropic", "claude-opus-4",           15.00, 75.00, 1.50,
               ("claude-opus-4-20250918",)),
    ModelPrice("anthropic", "claude-sonnet-4",          3.00, 15.00, 0.30,
               ("claude-sonnet-4-20250514",)),
    ModelPrice("anthropic", "claude-haiku-4",           0.80,  4.00, 0.08,
               ("claude-haiku-4-20250414",)),
    ModelPrice("anthropic", "claude-3.5-sonnet",        3.00, 15.00, 0.30,
               ("claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620")),
    ModelPrice("anthropic", "claude-3.5-haiku",         0.80,  4.00, 0.08),
    ModelPrice("anthropic", "claude-3-opus",           15.00, 75.00),
    ModelPrice("anthropic", "claude-3-haiku",           0.25,  1.25),
]

# ─── Google Gemini ──────────────────────────────────────────────────────────

# Verified against ai.google.dev/gemini-api/docs/pricing, 2026-08-21, at the
# short-context (<=200k) text tier. Gemini prices audio input and >200k context
# higher; those tiers are not modeled, so such usage is under-valued rather
# than guessed.
GOOGLE_PRICES = [
    ModelPrice("google", "gemini-3.6-flash",        0.75,  3.75,  0.075),
    ModelPrice("google", "gemini-3.5-flash",        1.50,  9.00,  0.15,
               ("gemini-3-flash",)),
    ModelPrice("google", "gemini-3.5-flash-lite",   0.30,  2.50,  0.03,
               ("gemini-3-flash-lite",)),
    ModelPrice("google", "gemini-3.1-flash-lite",   0.25,  1.50,  0.025),
    ModelPrice("google", "gemini-3.1-pro-preview",  2.00,  12.00, 0.20,
               ("gemini-3-pro", "gemini-3.5-pro")),
    ModelPrice("google", "gemini-2.5-pro",          1.25,  10.00, 0.125,
               ("gemini-2.5-pro-preview",)),
    ModelPrice("google", "gemini-2.5-flash",        0.30,  2.50,  0.03,
               ("gemini-2.5-flash-preview",)),
    ModelPrice("google", "gemini-2.5-flash-lite",   0.10,  0.40,  0.01),
]

# ─── Mistral ────────────────────────────────────────────────────────────────

# Verified against mistral.ai/pricing/api, 2026-08-21. The floating -latest
# aliases resolve to the current generation. Cache read is a 90% discount.
MISTRAL_PRICES = [
    ModelPrice("mistral", "mistral-large-3",        0.50, 1.50, 0.05,
               ("mistral-large-latest",)),
    ModelPrice("mistral", "mistral-medium-3.5",     1.50, 7.50, 0.15,
               ("mistral-medium-latest",)),
    ModelPrice("mistral", "mistral-small-4",        0.15, 0.60, 0.015,
               ("mistral-small-latest",)),
    ModelPrice("mistral", "ministral-3-3b",         0.10, 0.10, 0.01),
    ModelPrice("mistral", "ministral-3-8b",         0.15, 0.15, 0.015),
    ModelPrice("mistral", "ministral-3-14b",        0.20, 0.20, 0.02),
    ModelPrice("mistral", "codestral",              0.30, 0.90, 0.03,
               ("codestral-latest",)),
    ModelPrice("mistral", "mistral-embed",          0.10, 0.0),
]

# ─── Meta Llama (via Together / Groq / Replicate) ──────────────────────────

# Intentionally empty. Meta publishes no generally available first-party API
# pricing; its direct Llama API remains waitlisted. Llama rates come from
# third-party hosts that differ from each other and change over time, so no
# single rate can be sourced. Llama usage stays outside priced totals as an
# unknown model, the same treatment every other unsourced model gets.
LLAMA_PRICES = []

# ─── xAI Grok ───────────────────────────────────────────────────────────────

XAI_PRICES = [
    # Verified against docs.x.ai models pricing, 2026-08-21, at the <200k tier.
    # Delisted models keep their last published rates for older usage.
    ModelPrice("xai", "grok-build",        1.00,  2.00, 0.20,
               ("grok-build-0.1", "grok-build-b")),
    ModelPrice("xai", "grok-4.6",          2.00,  6.00, 0.50, ("grok-4.6-latest",)),
    ModelPrice("xai", "grok-4.5",          2.00,  6.00, 0.30, ("grok-4.5-latest",)),
    ModelPrice("xai", "grok-4.3",          1.25,  2.50, 0.20),
    ModelPrice("xai", "grok-4",            5.00, 15.00),
    ModelPrice("xai", "grok-4-fast",       0.20, 0.50),
    ModelPrice("xai", "grok-3",            3.00, 15.00),
    ModelPrice("xai", "grok-3-mini",       0.30, 0.50),
    ModelPrice("xai", "grok-2",            2.00, 10.00),
]

# ─── DeepSeek ───────────────────────────────────────────────────────────────

# Verified against api-docs.deepseek.com/quick_start/pricing, 2026-08-21.
# Base fields are off-peak; Pricer selects the published peak tier from time.
DEEPSEEK_PRICES = [
    ModelPrice("deepseek", "deepseek-v4-flash", 0.22, 0.66, 0.007,
               peak_utc_hours=((1, 4), (6, 10)), peak_input_per_1m=0.44,
               peak_output_per_1m=1.32, peak_cached_input_per_1m=0.014),
    ModelPrice("deepseek", "deepseek-v4-pro", 0.66, 1.98, 0.022,
               peak_utc_hours=((1, 4), (6, 10)), peak_input_per_1m=1.32,
               peak_output_per_1m=3.96, peak_cached_input_per_1m=0.044),
]

# ─── Cohere ─────────────────────────────────────────────────────────────────

COHERE_PRICES = [
    ModelPrice("cohere", "command-r-plus",  2.50, 10.00),
    ModelPrice("cohere", "command-r",       0.15,  0.60),
    ModelPrice("cohere", "command-r7b",     0.02,  0.06),
]

# ─── Z.AI (GLM/Zhipu) ──────────────────────────────────────────────────────

ZAI_PRICES = [
    ModelPrice("zai", "glm-5.3",       1.40, 4.40, 0.26),
    ModelPrice("zai", "glm-5.2",       1.40, 4.40, 0.26),
    ModelPrice("zai", "glm-5.1",       1.40, 4.40, 0.26),
    ModelPrice("zai", "glm-5",         1.00, 3.20, 0.20),
    ModelPrice("zai", "glm-5-turbo",   1.20, 4.00, 0.24),
    ModelPrice("zai", "glm-4.7",       0.60, 2.20, 0.11),
    ModelPrice("zai", "glm-4.7-flashx", 0.07, 0.40, 0.01),
    ModelPrice("zai", "glm-4.6",       0.60, 2.20, 0.11),
    ModelPrice("zai", "glm-4.5",       0.60, 2.20, 0.11),
    ModelPrice("zai", "glm-4.5-x",     2.20, 8.90, 0.45),
    ModelPrice("zai", "glm-4.5-air",   0.20, 1.10, 0.03),
    ModelPrice("zai", "glm-4.5-airx",  1.10, 4.50, 0.22),
    ModelPrice("zai", "glm-4-32b-0414-128k", 0.10, 0.10),
    ModelPrice("zai", "glm-4.7-flash", 0.00, 0.00),
    ModelPrice("zai", "glm-4.5-flash", 0.00, 0.00),
    ModelPrice("zai", "glm-5-plus",    0.70, 2.80),
    ModelPrice("zai", "glm-5-air",     0.10, 0.40),
    ModelPrice("zai", "glm-5-flash",   0.10, 0.10),
    ModelPrice("zai", "glm-4-plus",    0.50, 1.50),
    ModelPrice("zai", "glm-4-air",     0.10, 0.30),
    ModelPrice("zai", "glm-4-flash",   0.01, 0.01),
]

# ─── Master database ────────────────────────────────────────────────────────

ALL_PRICES = (
    OPENAI_PRICES + ANTHROPIC_PRICES + GOOGLE_PRICES
    + MISTRAL_PRICES + LLAMA_PRICES + XAI_PRICES
    + DEEPSEEK_PRICES + COHERE_PRICES + ZAI_PRICES
)

# Build lookup: canonical name + all aliases → ModelPrice
MODEL_PRICING: dict[str, ModelPrice] = {}
KNOWN_INTERNAL_UNPRICED = {
    "codex-auto-review": {
        "provider": "openai",
        "reason": (
            "OpenAI identifies this as Codex's internal automatic approval "
            "reviewer but does not publish a stable per-token price or "
            "billable model mapping."
        ),
    },
}

for _p in ALL_PRICES:
    MODEL_PRICING[_p.model] = _p
    for _alias in _p.aliases:
        MODEL_PRICING[_alias] = _p


class Pricer:
    """Calculate costs for LLM calls based on token usage and current pricing."""

    def __init__(self, custom_prices: dict[str, ModelPrice] | None = None):
        self._prices = dict(MODEL_PRICING)
        self._custom_models: set[str] = set()
        if custom_prices:
            self._prices.update(custom_prices)
            for key, price in custom_prices.items():
                self._custom_models.update((key, price.model, *price.aliases))

    def get_price(self, model: str) -> ModelPrice | None:
        """Look up pricing for a model, trying exact match then prefix match."""
        if model in self._prices:
            return self._prices[model]
        # Try prefix matching for versioned model names (e.g. "gpt-4o-2024-08-06")
        for key, price in self._prices.items():
            if model.startswith(key) or key.startswith(model):
                return price
        return None

    def price_call(
        self,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int = 0,
        provider: str = "",
        cache_creation_tokens: int = 0,
        cached_included_in_input: bool = True,
        cache_creation_included_in_input: bool = False,
        timestamp: float | None = None,
    ) -> tuple[float, float, float]:
        """
        Returns (input_cost, output_cost, total_cost) in USD.

        Handles cache-read discounts and cache-write premiums. OpenAI/Google report
        input_tokens inclusive of cached tokens (cached_included_in_input=True);
        Anthropic reports input/cache-read/cache-write as disjoint buckets.
        """
        price = self.get_price(model)

        if price is None:
            # Unknown models are unpriced. Keep the old heuristic available only
            # through rough_estimate_call(), never in authoritative totals.
            return (0.0, 0.0, 0.0)

        input_rate = price.input_per_1m
        output_rate = price.output_per_1m
        cached_rate = price.cached_input_per_1m
        if price.peak_utc_hours:
            raw_timestamp = timestamp
            if raw_timestamp is None:
                now = datetime.now(timezone.utc)
            else:
                seconds = raw_timestamp / 1000 if raw_timestamp > 100_000_000_000 else raw_timestamp
                now = datetime.fromtimestamp(seconds, timezone.utc)
            if any(start <= now.hour < end for start, end in price.peak_utc_hours):
                input_rate = price.peak_input_per_1m
                output_rate = price.peak_output_per_1m
                cached_rate = price.peak_cached_input_per_1m

        included_cache = (cached_tokens if cached_included_in_input else 0)
        if cache_creation_included_in_input:
            included_cache += cache_creation_tokens
        billable_input = max(0, input_tokens - included_cache)
        in_cost = (billable_input / 1_000_000) * input_rate

        # Cache-read tokens at discount rate
        if cached_tokens > 0 and cached_rate > 0:
            in_cost += (cached_tokens / 1_000_000) * cached_rate
        elif cached_tokens > 0:
            # If no explicit cached price, assume 50% discount
            in_cost += (cached_tokens / 1_000_000) * input_rate * 0.5

        # Cache-write tokens at a premium (Anthropic 5-min TTL is 1.25x input)
        if cache_creation_tokens > 0:
            write_rate = price.cache_write_per_1m or input_rate * 1.25
            in_cost += (cache_creation_tokens / 1_000_000) * write_rate

        out_cost = (output_tokens / 1_000_000) * output_rate

        return (
            round(in_cost, 6),
            round(out_cost, 6),
            round(in_cost + out_cost, 6),
        )

    def rough_estimate_call(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_creation_tokens: int = 0,
    ) -> tuple[float, float, float]:
        """Return the separate $2/$8-per-1M rough estimate for an unpriced call."""
        in_cost = ((input_tokens + cache_creation_tokens) / 1_000_000) * 2.0
        out_cost = (output_tokens / 1_000_000) * 8.0
        return (round(in_cost, 6), round(out_cost, 6), round(in_cost + out_cost, 6))

    def get_price_source(self, model: str) -> dict:
        """Describe whether a model price is verified, custom, or unpriced."""
        price = self.get_price(model)
        if price is None:
            internal = KNOWN_INTERNAL_UNPRICED.get(model)
            if internal:
                return {
                    "source": "internal",
                    "label": "internal / unpriced",
                    "authoritative": False,
                    "provider": internal["provider"],
                    "reason": internal["reason"],
                }
            return {
                "source": "fallback",
                "label": "fallback / unpriced",
                "authoritative": False,
            }
        if model in self._custom_models or price.model in self._custom_models:
            return {
                "source": "custom",
                "label": "custom local",
                "authoritative": True,
            }
        return {
            "source": "verified",
            "label": "verified built-in",
            "authoritative": True,
        }

    def list_models(self, provider: str = "") -> list[ModelPrice]:
        """List all known models, optionally filtered by provider."""
        seen = set()
        result = []
        for p in ALL_PRICES:
            if provider and p.provider != provider:
                continue
            if p.model not in seen:
                seen.add(p.model)
                result.append(p)
        return result

    def add_custom_price(self, price: ModelPrice):
        """Register a custom model price."""
        self._prices[price.model] = price
        self._custom_models.add(price.model)
        for alias in price.aliases:
            self._prices[alias] = price
            self._custom_models.add(alias)
