"""
Core tracking engine for Tokimeter.

Provides:
  - Tracker: the main class for recording LLM calls
  - track() context manager: attribute calls to a workflow
  - Auto-instrumentation for OpenAI, Anthropic, and Google Gemini SDKs
  - In-memory and persistent (SQLite) modes
"""

from __future__ import annotations

import contextvars
import functools
import threading
import time
import uuid
from typing import Any, Callable, Optional

from .models import LLMCall, AgentRun
from .pricing import Pricer
from .backends import create_backend, SQLiteStore

# ─── Context tracking ────────────────────────────────────────────────────────

# Tracks which agent/workflow/customer the current execution belongs to.
_context_var: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "tokimeter_context",
    default={},
)


def _get_context() -> dict:
    return _context_var.get()


def _set_context(ctx: dict):
    _context_var.set(ctx)


# ─── Tracker ─────────────────────────────────────────────────────────────────


class Tracker:
    """
    Main tracker for Tokimeter.

    Usage:
        tracker = Tracker()                    # in-memory
        tracker = Tracker("finops.db")         # SQLite persistent

        # Manual tracking
        tracker.record(provider="openai", model="gpt-4o",
                       input_tokens=500, output_tokens=200)

        # Context manager for workflow attribution
        with tracker.track("customer-support", workflow="triage"):
            # all calls inside get attributed to this agent/workflow
            ...

        # Auto-instrument OpenAI
        tracker.instrument_openai()
    """

    _global: Optional["Tracker"] = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        db_path: str = "",       # empty = in-memory (dict-based)
        pricer: Pricer | None = None,
        backend=None,            # pass a pre-built backend (SQLiteStore or SupabaseStore)
        use_async: bool = False, # enable async batched writes
    ):
        self.pricer = pricer or Pricer()
        self._backend = backend or (create_backend(db_path) if db_path else None)
        self._memory_calls: list[LLMCall] = []
        self._instrumented: set[str] = set()
        self._async_writer = None

        if use_async and self._backend:
            from .async_writer import AsyncWriter
            self._async_writer = AsyncWriter(self._backend)
            self._async_writer.start()

        # Register as global if none exists
        with Tracker._instance_lock:
            if Tracker._global is None:
                Tracker._global = self

    @classmethod
    def get_global(cls) -> Optional["Tracker"]:
        return cls._global

    @classmethod
    def set_global(cls, tracker: "Tracker"):
        cls._global = tracker

    # ─── Recording ───────────────────────────────────────────────────────────

    def record(
        self,
        *,
        provider: str = "",
        model: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        agent_name: str = "",
        workflow: str = "",
        customer: str = "",
        latency_ms: float = 0.0,
        success: bool = True,
        error: str = "",
        tags: dict | None = None,
        input_cost: float = 0.0,   # pre-computed costs override pricing
        output_cost: float = 0.0,
    ) -> LLMCall:
        """Record a single LLM call with automatic cost calculation."""

        # Inherit from context if not specified
        ctx = _get_context()
        agent_name = agent_name or ctx.get("agent_name", "default")
        workflow = workflow or ctx.get("workflow", "default")
        customer = customer or ctx.get("customer", "")

        call_tags = dict(tags or {})

        # Calculate costs if not pre-provided
        if input_cost == 0 and output_cost == 0:
            source = self.pricer.get_price_source(model)
            input_cost, output_cost, total_cost = self.pricer.price_call(
                model, input_tokens, output_tokens, cached_tokens, provider
            )
            call_tags["pricing_source"] = source["source"]
            call_tags["pricing_authoritative"] = source["authoritative"]
            if not source["authoritative"]:
                _, _, rough = self.pricer.rough_estimate_call(input_tokens, output_tokens)
                call_tags["rough_estimate_cost"] = rough
        else:
            total_cost = input_cost + output_cost
            call_tags["pricing_source"] = "reported"
            call_tags["pricing_authoritative"] = True

        call = LLMCall(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            input_cost=input_cost,
            output_cost=output_cost,
            total_cost=total_cost,
            agent_name=agent_name,
            workflow=workflow,
            customer=customer,
            latency_ms=latency_ms,
            success=success,
            error=error,
            tags=call_tags,
        )

        self._persist(call)
        return call

    def record_call(self, call: LLMCall):
        """Record a pre-built LLMCall object."""
        if "pricing_source" not in call.tags:
            if call.total_cost or call.input_cost or call.output_cost:
                call.tags["pricing_source"] = "reported"
                call.tags["pricing_authoritative"] = True
            else:
                self._normalize_loaded_pricing(call)
        self._persist(call)

    def _normalize_loaded_pricing(self, call: LLMCall):
        """Conservatively classify older stored calls before reporting them."""
        if "pricing_source" in call.tags:
            return
        source = self.pricer.get_price_source(call.model)
        call.tags["pricing_source"] = source["source"]
        call.tags["pricing_authoritative"] = source["authoritative"]
        if source["authoritative"]:
            return

        # Older releases stored the fallback inside total_cost. Treat an
        # unlabeled unknown-model amount as rough, not authoritative.
        rough = call.total_cost
        if not rough:
            _, _, rough = self.pricer.rough_estimate_call(
                call.input_tokens, call.output_tokens
            )
        call.tags["rough_estimate_cost"] = rough
        call.input_cost = 0.0
        call.output_cost = 0.0
        call.total_cost = 0.0

    def _persist(self, call: LLMCall):
        if self._async_writer:
            self._async_writer.enqueue(call)
        elif self._backend:
            self._backend.record_call(call)
        else:
            self._memory_calls.append(call)

    # ─── Querying ────────────────────────────────────────────────────────────

    def get_calls(self, **kwargs) -> list[LLMCall]:
        if self._backend:
            results = self._backend.get_calls(**kwargs)
            for call in results:
                self._normalize_loaded_pricing(call)
            return results
        # In-memory filtering
        results = list(self._memory_calls)
        limit = kwargs.get("limit", 0)
        for key, val in kwargs.items():
            if not val:  # skip empty/zero values (e.g. end_time=0 means "now")
                continue
            if key in ("agent_name", "workflow", "model", "customer"):
                results = [c for c in results if getattr(c, key) == val]
            elif key == "start_time":
                results = [c for c in results if c.timestamp >= val]
            elif key == "end_time":
                results = [c for c in results if c.timestamp <= val]
        if limit:
            results = results[:limit]
        for call in results:
            self._normalize_loaded_pricing(call)
        return results

    def get_report(self, start_time: float = 0, end_time: float = 0):
        from .models import CostReport

        calls = self.get_calls(start_time=start_time, end_time=end_time)
        report = CostReport(period_start=start_time, period_end=end_time or time.time())
        for call in calls:
            report.add_call(call)
        return report

    def total_cost(self) -> float:
        return self.get_report().total_cost

    def total_calls(self) -> int:
        if self._backend:
            return self._backend.count()
        return len(self._memory_calls)

    @property
    def backend(self):
        """Access the underlying storage backend."""
        return self._backend

    def flush(self):
        """Manually flush async writer if enabled."""
        if self._async_writer:
            self._async_writer.flush()

    def close(self):
        """Clean shutdown — flush async writer and close backend."""
        if self._async_writer:
            self._async_writer.stop()
        if self._backend:
            self._backend.close()

    # ─── Context manager ─────────────────────────────────────────────────────

    def track(
        self,
        agent_name: str = "",
        workflow: str = "",
        customer: str = "",
        **extra_tags,
    ):
        """Context manager that attributes all calls inside to a workflow."""
        return _TrackContext(self, agent_name, workflow, customer, extra_tags)

    # ─── Auto-instrumentation ────────────────────────────────────────────────

    def instrument_openai(self, client=None) -> bool:
        """
        Auto-instrument the OpenAI Python SDK.

        Pass an openai.OpenAI() client to instrument a specific instance,
        or call with no args to patch the module-level client.

        Returns True if instrumentation succeeded.
        """
        key = "openai"
        if key in self._instrumented:
            return True

        try:
            import openai
            tracker = self

            original_create = openai.resources.chat.completions.Completions.create

            @functools.wraps(original_create)
            def patched_create(self_inner, *args, **kwargs):
                start = time.time()
                success = True
                error_msg = ""

                try:
                    response = original_create(self_inner, *args, **kwargs)
                    return response
                except Exception as e:
                    success = False
                    error_msg = str(e)
                    raise
                finally:
                    latency = (time.time() - start) * 1000

                    # Extract usage from response if available
                    input_tokens = 0
                    output_tokens = 0
                    cached_tokens = 0
                    model_name = kwargs.get("model", "")

                    if success and hasattr(response, "usage"):
                        usage = response.usage
                        input_tokens = getattr(usage, "prompt_tokens", 0) or 0
                        output_tokens = (
                            getattr(usage, "completion_tokens", 0)
                            or getattr(usage, "output_tokens", 0)
                            or 0
                        )
                        cached = getattr(usage, "prompt_tokens_details", None)
                        if cached and hasattr(cached, "cached_tokens"):
                            cached_tokens = cached.cached_tokens or 0

                    tracker.record(
                        provider="openai",
                        model=model_name,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cached_tokens=cached_tokens,
                        latency_ms=latency,
                        success=success,
                        error=error_msg,
                    )

            openai.resources.chat.completions.Completions.create = patched_create
            self._instrumented.add(key)
            return True

        except ImportError:
            return False

    def instrument_anthropic(self, client=None) -> bool:
        """
        Auto-instrument the Anthropic Python SDK.

        Patches client.messages.create to track token usage and cost.
        """
        key = "anthropic"
        if key in self._instrumented:
            return True

        try:
            import anthropic
            tracker = self

            original_create = anthropic.resources.messages.Messages.create

            @functools.wraps(original_create)
            def patched_create(self_inner, *args, **kwargs):
                start = time.time()
                success = True
                error_msg = ""

                try:
                    response = original_create(self_inner, *args, **kwargs)
                    return response
                except Exception as e:
                    success = False
                    error_msg = str(e)
                    raise
                finally:
                    latency = (time.time() - start) * 1000

                    input_tokens = 0
                    output_tokens = 0
                    cached_tokens = 0
                    model_name = kwargs.get("model", "")

                    if success and hasattr(response, "usage"):
                        usage = response.usage
                        input_tokens = getattr(usage, "input_tokens", 0) or 0
                        output_tokens = getattr(usage, "output_tokens", 0) or 0
                        # Anthropic cache
                        if hasattr(usage, "cache_read_input_tokens"):
                            cached_tokens = usage.cache_read_input_tokens or 0

                    tracker.record(
                        provider="anthropic",
                        model=model_name,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cached_tokens=cached_tokens,
                        latency_ms=latency,
                        success=success,
                        error=error_msg,
                    )

            anthropic.resources.messages.Messages.create = patched_create
            self._instrumented.add(key)
            return True

        except ImportError:
            return False

    def instrument_google(self, client=None) -> bool:
        """
        Auto-instrument Google Generative AI SDK (google.generativeai).

        Patches GenerativeModel.generate_content to track usage.
        """
        key = "google"
        if key in self._instrumented:
            return True

        try:
            import google.generativeai as genai
            tracker = self

            original_generate = genai.GenerativeModel.generate_content

            @functools.wraps(original_generate)
            def patched_generate(self_inner, *args, **kwargs):
                start = time.time()
                success = True
                error_msg = ""

                try:
                    response = original_generate(self_inner, *args, **kwargs)
                    return response
                except Exception as e:
                    success = False
                    error_msg = str(e)
                    raise
                finally:
                    latency = (time.time() - start) * 1000

                    input_tokens = 0
                    output_tokens = 0
                    model_name = getattr(self_inner, "model_name", "gemini-1.5-flash")

                    if success and hasattr(response, "usage_metadata"):
                        usage = response.usage_metadata
                        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
                        output_tokens = getattr(usage, "candidates_token_count", 0) or 0

                    tracker.record(
                        provider="google",
                        model=model_name,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        latency_ms=latency,
                        success=success,
                        error=error_msg,
                    )

            genai.GenerativeModel.generate_content = patched_generate
            self._instrumented.add(key)
            return True

        except ImportError:
            return False

    def instrument_all(self):
        """Attempt to instrument all supported SDKs. Returns dict of results."""
        return {
            "openai": self.instrument_openai(),
            "anthropic": self.instrument_anthropic(),
            "google": self.instrument_google(),
        }


# ─── Track context manager ──────────────────────────────────────────────────


class _TrackContext:
    """Context manager for attributing calls to a workflow."""

    def __init__(
        self,
        tracker: Tracker,
        agent_name: str,
        workflow: str,
        customer: str,
        extra_tags: dict,
    ):
        self.tracker = tracker
        self.agent_name = agent_name
        self.workflow = workflow
        self.customer = customer
        self.extra_tags = extra_tags
        self._token = None
        self._previous_ctx = None
        self.run: AgentRun | None = None

    def __enter__(self) -> AgentRun:
        self._previous_ctx = _get_context()
        new_ctx = {
            **self._previous_ctx,
            "agent_name": self.agent_name or self._previous_ctx.get("agent_name", "default"),
            "workflow": self.workflow or self._previous_ctx.get("workflow", "default"),
            "customer": self.customer or self._previous_ctx.get("customer", ""),
        }
        self._token = _context_var.set(new_ctx)

        self.run = AgentRun(
            agent_name=new_ctx["agent_name"],
            workflow=new_ctx["workflow"],
            customer=new_ctx["customer"],
            tags=self.extra_tags,
        )
        return self.run

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.run.end_time = time.time()
        if self._token is not None:
            _context_var.reset(self._token)
        return False


# ─── Convenience module-level API ────────────────────────────────────────────


def track(agent_name: str = "", workflow: str = "", customer: str = "", **tags):
    """
    Context manager using the global tracker.

    Usage:
        from tokimeter import track

        with track("support-bot", workflow="ticket-triage"):
            response = openai.chat.completions.create(...)
            # This call is automatically attributed to support-bot/ticket-triage
    """
    tracker = Tracker.get_global()
    if tracker is None:
        tracker = Tracker()
        Tracker.set_global(tracker)
    return tracker.track(agent_name, workflow, customer, **tags)


def current_tracker() -> Tracker | None:
    """Get the global tracker if one exists."""
    return Tracker.get_global()
