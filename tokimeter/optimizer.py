"""
Cost optimizer / recommendations engine for Tokimeter.

Analyzes recorded LLM calls and generates actionable recommendations
to reduce spend without sacrificing quality.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Optional

from .models import LLMCall, Recommendation
from .pricing import Pricer, ModelPrice, MODEL_PRICING


# ─── Cheaper alternative model mappings ──────────────────────────────────────
# Maps expensive models to cheaper alternatives for "downgrade" suggestions.
# These are conservative — the cheaper model should handle the same task adequately.

DOWNGRADE_PATHS: dict[str, list[tuple[str, float]]] = {
    # model: [(cheaper_alternative, expected_quality_retention_pct), ...]
    "gpt-4o": [
        ("gpt-4o-mini", 0.95),
        ("gpt-4.1-mini", 0.95),
        ("gpt-4.1-nano", 0.85),
    ],
    "gpt-4.1": [
        ("gpt-4.1-mini", 0.95),
        ("gpt-4.1-nano", 0.85),
    ],
    "o1": [
        ("o1-mini", 0.90),
        ("o3-mini", 0.90),
    ],
    "o3": [
        ("o3-mini", 0.92),
        ("o4-mini", 0.92),
    ],
    "claude-opus-4": [
        ("claude-sonnet-4", 0.95),
        ("claude-3.5-sonnet", 0.93),
        ("claude-haiku-4", 0.85),
    ],
    "claude-sonnet-4": [
        ("claude-haiku-4", 0.88),
        ("claude-3.5-haiku", 0.88),
    ],
    "claude-3.5-sonnet": [
        ("claude-3.5-haiku", 0.88),
        ("claude-haiku-4", 0.88),
    ],
    "gemini-2.5-pro": [
        ("gemini-2.5-flash", 0.92),
    ],
    "gemini-3-pro": [
        ("gemini-3-flash", 0.92),
        ("gemini-3-flash-lite", 0.85),
    ],
    "grok-4": [
        ("grok-4-fast", 0.95),
        ("grok-3-mini", 0.85),
    ],
    "grok-3": [
        ("grok-3-mini", 0.88),
    ],
    # deepseek-r1 -> deepseek-v3 and llama-3.1-405b -> llama-3.1-70b were
    # dropped with their prices. A downgrade to an unpriced model would produce
    # a savings number with nothing behind it.
    "mistral-medium-3.5": [
        ("mistral-small-4", 0.90),
    ],
    "command-r-plus": [
        ("command-r", 0.92),
    ],
    "glm-5-plus": [
        ("glm-5-air", 0.90),
        ("glm-5-flash", 0.85),
    ],
}


class Optimizer:
    """
    Analyzes LLM call history and generates cost optimization recommendations.

    Usage:
        optimizer = Optimizer(pricer)
        recs = optimizer.analyze(calls)

        for rec in recs:
            print(f"{rec.severity}: {rec.title}")
            print(f"  Save ${rec.estimated_savings_monthly:.2f}/mo")
    """

    def __init__(self, pricer: Pricer | None = None):
        self.pricer = pricer or Pricer()

    def analyze(
        self,
        calls: list[LLMCall],
        period_days: int = 30,
    ) -> list[Recommendation]:
        """
        Analyze a set of calls and return recommendations sorted by impact.

        Args:
            calls: List of LLM calls to analyze.
            period_days: The period these calls cover, for monthly extrapolation.
        """
        recs: list[Recommendation] = []

        if not calls:
            return recs

        # Determine actual time span
        if len(calls) > 1:
            timestamps = [c.timestamp for c in calls]
            span_seconds = max(timestamps) - min(timestamps)
            span_days = max(span_seconds / 86400, 1) if span_seconds > 0 else period_days
        else:
            span_days = period_days

        # Monthly multiplier: extrapolate from observed period to 30 days
        monthly_mult = 30.0 / span_days

        recs.extend(self._find_downgrade_opportunities(calls, monthly_mult))
        recs.extend(self._find_cache_opportunities(calls, monthly_mult))
        recs.extend(self._find_anomalies(calls, monthly_mult))
        recs.extend(self._find_repeated_prompts(calls, monthly_mult))
        recs.extend(self._find_error_waste(calls, monthly_mult))

        # Sort by savings descending, then severity
        severity_order = {"critical": 0, "warning": 1, "info": 2}
        recs.sort(key=lambda r: (-r.estimated_savings_monthly, severity_order.get(r.severity, 3)))

        return recs

    # ─── Recommendation generators ───────────────────────────────────────────

    def _find_downgrade_opportunities(
        self, calls: list[LLMCall], monthly_mult: float
    ) -> list[Recommendation]:
        """Find calls using expensive models that could use cheaper alternatives."""
        recs = []

        # Group by (model, agent_name) to find per-workflow downgrade opportunities
        model_agent_costs: dict[tuple[str, str], dict] = defaultdict(lambda: {
            "cost": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0
        })

        for call in calls:
            key = (call.model, call.agent_name)
            entry = model_agent_costs[key]
            entry["cost"] += call.total_cost
            entry["calls"] += 1
            entry["input_tokens"] += call.input_tokens
            entry["output_tokens"] += call.output_tokens

        for (model, agent), stats in model_agent_costs.items():
            if model not in DOWNGRADE_PATHS:
                continue

            monthly_cost = stats["cost"] * monthly_mult
            if monthly_cost < 1.0:
                continue  # too small to bother

            for cheaper_model, quality_retention in DOWNGRADE_PATHS[model]:
                # Calculate what the same usage would cost with the cheaper model
                cheaper_price = self.pricer.get_price(cheaper_model)
                if not cheaper_price:
                    continue

                cheaper_cost = (
                    (stats["input_tokens"] / 1_000_000) * cheaper_price.input_per_1m
                    + (stats["output_tokens"] / 1_000_000) * cheaper_price.output_per_1m
                )
                savings = (stats["cost"] - cheaper_cost) * monthly_mult

                if savings < 0.50:
                    continue

                severity = "critical" if quality_retention >= 0.95 else "warning"
                if savings > 50:
                    severity = "critical"

                current_price = self.pricer.get_price(model)
                current_rates = (
                    f"${current_price.input_per_1m}/${current_price.output_per_1m}"
                    if current_price else "?"
                )
                cheaper_rates = (
                    f"${cheaper_price.input_per_1m}/${cheaper_price.output_per_1m}"
                )

                rec = Recommendation(
                    severity=severity,
                    title=f"Downgrade {agent} from {model} → {cheaper_model}",
                    description=(
                        f"Agent '{agent}' made {stats['calls']} calls using {model} "
                        f"({current_rates}/M tokens). Switching to {cheaper_model} "
                        f"({cheaper_rates}/M) saves ${savings:.2f}/mo with "
                        f"~{quality_retention:.0%} expected quality retention."
                    ),
                    estimated_savings_monthly=round(savings, 2),
                    action=f"Route {agent}'s calls to {cheaper_model}",
                    affected_calls=stats["calls"],
                    current_model=model,
                    suggested_model=cheaper_model,
                )
                recs.append(rec)
                break  # only suggest the best (first) downgrade

        return recs

    def _find_cache_opportunities(
        self, calls: list[LLMCall], monthly_mult: float
    ) -> list[Recommendation]:
        """Find calls that could benefit from prompt caching."""
        recs = []

        # Group by agent + model to find repeated system prompts
        agent_model: dict[tuple[str, str], dict] = defaultdict(lambda: {
            "cost": 0.0, "calls": 0, "input_tokens": 0,
            "cached_tokens": 0, "providers": set(),
        })

        for call in calls:
            key = (call.agent_name, call.model)
            entry = agent_model[key]
            entry["cost"] += call.total_cost
            entry["calls"] += 1
            entry["input_tokens"] += call.input_tokens
            entry["cached_tokens"] += call.cached_tokens
            entry["providers"].add(call.provider)

        for (agent, model), stats in agent_model.items():
            if stats["calls"] < 10:
                continue

            cache_ratio = stats["cached_tokens"] / max(stats["input_tokens"], 1)

            # If already caching >80%, skip
            if cache_ratio > 0.80:
                continue

            # Estimate that ~50% of input tokens are cacheable (system prompt, context)
            cacheable_tokens = int(stats["input_tokens"] * 0.50)
            uncached_cost = (cacheable_tokens / 1_000_000)

            price = self.pricer.get_price(model)
            if not price or price.cached_input_per_1m <= 0:
                continue

            # Savings from caching the cacheable portion
            current_cost = (cacheable_tokens / 1_000_000) * price.input_per_1m
            cached_cost = (cacheable_tokens / 1_000_000) * price.cached_input_per_1m
            savings = (current_cost - cached_cost) * monthly_mult

            if savings < 0.50:
                continue

            rec = Recommendation(
                severity="info",
                title=f"Enable prompt caching for {agent} ({model})",
                description=(
                    f"Agent '{agent}' sent {stats['input_tokens']:,} input tokens "
                    f"across {stats['calls']} calls, but only "
                    f"{stats['cached_tokens']:,} ({cache_ratio:.0%}) were served from cache. "
                    f"Enabling prompt caching could save ${savings:.2f}/mo."
                ),
                estimated_savings_monthly=round(savings, 2),
                action=f"Enable prompt caching for {model} in {agent}",
                affected_calls=stats["calls"],
                current_model=model,
                suggested_model=model,
            )
            recs.append(rec)

        return recs

    def _find_anomalies(
        self, calls: list[LLMCall], monthly_mult: float
    ) -> list[Recommendation]:
        """Find anomalous expensive calls (outlier token usage)."""
        recs = []

        # Group by agent+model to establish baselines
        groups: dict[tuple[str, str], list[LLMCall]] = defaultdict(list)
        for call in calls:
            if call.success:
                groups[(call.agent_name, call.model)].append(call)

        for (agent, model), group_calls in groups.items():
            if len(group_calls) < 5:
                continue

            costs = [c.total_cost for c in group_calls]
            avg_cost = sum(costs) / len(costs)

            # Find calls that cost >3x average
            outliers = [c for c in group_calls if c.total_cost > avg_cost * 3 and c.total_cost > 0.01]

            if not outliers:
                continue

            outlier_cost = sum(c.total_cost for c in outliers)
            normal_cost = avg_cost * len(outliers)
            waste = (outlier_cost - normal_cost) * monthly_mult

            if waste < 1.0:
                continue

            rec = Recommendation(
                severity="warning",
                title=f"Anomalous expensive calls in {agent} ({model})",
                description=(
                    f"{len(outliers)} calls in '{agent}' cost >3x the average "
                    f"(${avg_cost:.4f}). These outliers total ${outlier_cost:.2f} "
                    f"— likely due to oversized context windows or runaway output. "
                    f"Review prompt templates and set max_tokens limits."
                ),
                estimated_savings_monthly=round(waste, 2),
                action=f"Set max_tokens and context limits for {agent}",
                affected_calls=len(outliers),
                current_model=model,
                suggested_model=model,
            )
            recs.append(rec)

        return recs

    def _find_repeated_prompts(
        self, calls: list[LLMCall], monthly_mult: float
    ) -> list[Recommendation]:
        """Find repeated identical calls that could be cached or deduplicated."""
        recs = []

        # Group by agent+model+input_tokens (proxy for identical prompts)
        signature_counts: dict[tuple, dict] = defaultdict(lambda: {"count": 0, "cost": 0.0})

        for call in calls:
            sig = (call.agent_name, call.model, call.input_tokens, call.output_tokens)
            entry = signature_counts[sig]
            entry["count"] += 1
            entry["cost"] += call.total_cost

        for sig, stats in signature_counts.items():
            if stats["count"] < 20:
                continue

            # If the same prompt+output pattern repeats >20 times, that's cacheable
            waste = stats["cost"] * 0.7 * monthly_mult  # 70% savings from caching

            if waste < 1.0:
                continue

            agent, model = sig[0], sig[1]

            rec = Recommendation(
                severity="info",
                title=f"Deduplicate repeated calls in {agent} ({model})",
                description=(
                    f"{stats['count']} calls in '{agent}' have identical token signatures, "
                    f"totaling ${stats['cost']:.2f}. Add a response cache (e.g. Redis or "
                    f"in-memory LRU) to serve repeated queries without calling the LLM."
                ),
                estimated_savings_monthly=round(waste, 2),
                action=f"Add response caching for {agent}",
                affected_calls=stats["count"],
                current_model=model,
                suggested_model=model,
            )
            recs.append(rec)

        return recs

    def _find_error_waste(
        self, calls: list[LLMCall], monthly_mult: float
    ) -> list[Recommendation]:
        """Find wasted spend on failed calls."""
        recs = []

        failed = [c for c in calls if not c.success]
        if not failed:
            return recs

        waste = sum(c.total_cost for c in failed)
        monthly_waste = waste * monthly_mult

        if monthly_waste < 0.50:
            return recs

        # Group by error
        error_costs: dict[str, dict] = defaultdict(lambda: {"cost": 0.0, "count": 0})
        for call in failed:
            error_key = call.error[:80] if call.error else "Unknown error"
            entry = error_costs[error_key]
            entry["cost"] += call.total_cost
            entry["count"] += 1

        top_error = max(error_costs.items(), key=lambda x: x[1]["count"])

        rec = Recommendation(
            severity="critical" if monthly_waste > 10 else "warning",
            title=f"Failed calls wasting ${monthly_waste:.2f}/mo",
            description=(
                f"{len(failed)} failed calls cost ${waste:.2f} in the observed period. "
                f"Most common: \"{top_error[0]}\" ({top_error[1]['count']}x). "
                f"Add retries with exponential backoff and input validation."
            ),
            estimated_savings_monthly=round(monthly_waste, 2),
            action="Add retry logic and input validation",
            affected_calls=len(failed),
            current_model="",
            suggested_model="",
        )
        recs.append(rec)

        return recs
