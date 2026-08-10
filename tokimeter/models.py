"""
Data models for Tokimeter.

All models are plain dataclasses — zero dependencies, fully serializable.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LLMCall:
    """A single LLM API call (e.g. one chat.completions.create or messages.create)."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)

    # Identity
    provider: str = ""           # "openai", "anthropic", "google", "custom"
    model: str = ""              # "gpt-4o", "claude-sonnet-4-20250514", "gemini-2.5-flash"

    # Usage
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0       # tokens served from cache (discounted)

    # Computed
    input_cost: float = 0.0
    output_cost: float = 0.0
    total_cost: float = 0.0

    # Attribution
    agent_name: str = "default"
    workflow: str = "default"
    customer: str = ""           # which end-customer/project this call serves
    tags: dict = field(default_factory=dict)

    # Meta
    latency_ms: float = 0.0
    success: bool = True
    error: str = ""

    def __post_init__(self):
        if not self.total_cost and (self.input_cost or self.output_cost):
            self.total_cost = self.input_cost + self.output_cost


@dataclass
class AgentRun:
    """A logical agent run — one or more LLM calls grouped into a workflow execution."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_name: str = "default"
    workflow: str = "default"
    customer: str = ""
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    calls: list[LLMCall] = field(default_factory=list)
    tags: dict = field(default_factory=dict)

    @property
    def total_cost(self) -> float:
        return sum(c.total_cost for c in self.calls)

    @property
    def total_input_tokens(self) -> int:
        return sum(c.input_tokens for c in self.calls)

    @property
    def total_output_tokens(self) -> int:
        return sum(c.output_tokens for c in self.calls)

    @property
    def latency_ms(self) -> float:
        if self.end_time and self.start_time:
            return (self.end_time - self.start_time) * 1000
        return 0.0

    @property
    def call_count(self) -> int:
        return len(self.calls)


@dataclass
class CostReport:
    """Aggregated cost report for a time period."""

    period_start: float = 0.0
    period_end: float = 0.0
    total_cost: float = 0.0
    total_input_cost: float = 0.0
    total_output_cost: float = 0.0
    total_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    rough_estimate_cost: float = 0.0
    unpriced_calls: int = 0
    pricing_sources: dict = field(default_factory=dict)

    # Breakdowns
    by_provider: dict = field(default_factory=dict)    # {provider: cost}
    by_model: dict = field(default_factory=dict)       # {model: cost}
    by_agent: dict = field(default_factory=dict)       # {agent_name: cost}
    by_workflow: dict = field(default_factory=dict)    # {workflow: cost}
    by_customer: dict = field(default_factory=dict)    # {customer: cost}
    by_day: dict = field(default_factory=dict)         # {YYYY-MM-DD: cost}

    def add_call(self, call: LLMCall):
        self.total_cost += call.total_cost
        self.total_input_cost += call.input_cost
        self.total_output_cost += call.output_cost
        self.total_calls += 1
        self.total_input_tokens += call.input_tokens
        self.total_output_tokens += call.output_tokens

        source = str(call.tags.get("pricing_source", "reported"))
        self.pricing_sources[source] = self.pricing_sources.get(source, 0) + 1
        rough = float(call.tags.get("rough_estimate_cost", 0) or 0)
        self.rough_estimate_cost += rough
        if source in ("fallback", "internal"):
            self.unpriced_calls += 1

        for dim, attr in [
            (call.provider, "by_provider"),
            (call.model, "by_model"),
            (call.agent_name, "by_agent"),
            (call.workflow, "by_workflow"),
            (call.customer or "unassigned", "by_customer"),
        ]:
            d = getattr(self, attr)
            d[dim] = round(d.get(dim, 0) + call.total_cost, 6)

        day = time.strftime("%Y-%m-%d", time.gmtime(call.timestamp))
        self.by_day[day] = round(self.by_day.get(day, 0) + call.total_cost, 6)


@dataclass
class Recommendation:
    """A cost optimization recommendation."""

    severity: str = "info"       # "critical", "warning", "info"
    title: str = ""
    description: str = ""
    estimated_savings_monthly: float = 0.0
    action: str = ""             # human-readable action to take
    affected_calls: int = 0
    current_model: str = ""
    suggested_model: str = ""
