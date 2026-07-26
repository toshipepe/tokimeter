"""
Integration helpers for popular AI agent frameworks.

Supports:
  - LangChain (ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI)
  - CrewAI (Agents and Tasks)
  - Generic (works with any framework that uses OpenAI/Anthropic/Google SDKs)

These helpers add cost attribution without requiring you to change your
agent code. Just call one function and all LLM calls within your agent
workflow are automatically tracked.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any

from .core import Tracker, _get_context, _set_context

logger = logging.getLogger("tokimeter")


# ─── LangChain ───────────────────────────────────────────────────────────────


def instrument_langchain(tracker: Tracker) -> bool:
    """
    Instrument LangChain chat models to track token usage and cost.

    Patches:
      - langchain_openai.ChatOpenAI
      - langchain_anthropic.ChatAnthropic
      - langchain_google_genai.ChatGoogleGenerativeAI

    Works with LangChain's .invoke(), .batch(), and .stream() methods.

    Usage:
        from tokimeter import Tracker
        from tokimeter.integrations import instrument_langchain

        tracker = Tracker("finops.db")
        instrument_langchain(tracker)

        # Now all LangChain calls are tracked automatically
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model="gpt-4o")
        response = llm.invoke("Hello!")  # → tracked
    """
    success = False

    # ─── ChatOpenAI ──────────────────────────────────────────────────────
    try:
        from langchain_core.outputs import LLMResult
        from langchain_openai import ChatOpenAI

        original_generate = ChatOpenAI._generate

        @functools.wraps(original_generate)
        def patched_generate(self, messages, stop=None, run_manager=None, **kwargs):
            start = time.time()
            result = original_generate(self, messages, stop, run_manager, **kwargs)
            latency = (time.time() - start) * 1000

            ctx = _get_context()

            # Extract usage from the generation
            try:
                gen = result.generations[0][0]
                usage = getattr(gen, "usage_metadata", None) or {}
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
            except (IndexError, AttributeError):
                input_tokens = 0
                output_tokens = 0

            tracker.record(
                provider="openai",
                model=self.model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=latency,
                agent_name=ctx.get("agent_name", "langchain"),
                workflow=ctx.get("workflow", "default"),
            )
            return result

        ChatOpenAI._generate = patched_generate
        success = True
        logger.debug("Instrumented langchain_openai.ChatOpenAI")
    except ImportError:
        pass

    # ─── ChatAnthropic ───────────────────────────────────────────────────
    try:
        from langchain_anthropic import ChatAnthropic

        original_generate = ChatAnthropic._generate

        @functools.wraps(original_generate)
        def patched_generate(self, messages, stop=None, run_manager=None, **kwargs):
            start = time.time()
            result = original_generate(self, messages, stop, run_manager, **kwargs)
            latency = (time.time() - start) * 1000

            ctx = _get_context()

            try:
                gen = result.generations[0][0]
                usage = getattr(gen, "usage_metadata", None) or {}
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
            except (IndexError, AttributeError):
                input_tokens = 0
                output_tokens = 0

            tracker.record(
                provider="anthropic",
                model=self.model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=latency,
                agent_name=ctx.get("agent_name", "langchain"),
                workflow=ctx.get("workflow", "default"),
            )
            return result

        ChatAnthropic._generate = patched_generate
        success = True
        logger.debug("Instrumented langchain_anthropic.ChatAnthropic")
    except ImportError:
        pass

    # ─── ChatGoogleGenerativeAI ──────────────────────────────────────────
    try:
        from langchain_google_genai import ChatGoogleGenerativeAI

        original_generate = ChatGoogleGenerativeAI._generate

        @functools.wraps(original_generate)
        def patched_generate(self, messages, stop=None, run_manager=None, **kwargs):
            start = time.time()
            result = original_generate(self, messages, stop, run_manager, **kwargs)
            latency = (time.time() - start) * 1000

            ctx = _get_context()

            try:
                gen = result.generations[0][0]
                usage = getattr(gen, "usage_metadata", None) or {}
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
            except (IndexError, AttributeError):
                input_tokens = 0
                output_tokens = 0

            tracker.record(
                provider="google",
                model=self.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=latency,
                agent_name=ctx.get("agent_name", "langchain"),
                workflow=ctx.get("workflow", "default"),
            )
            return result

        ChatGoogleGenerativeAI._generate = patched_generate
        success = True
        logger.debug("Instrumented langchain_google_genai.ChatGoogleGenerativeAI")
    except ImportError:
        pass

    return success


# ─── CrewAI ──────────────────────────────────────────────────────────────────


def instrument_crewai(tracker: Tracker) -> bool:
    """
    Instrument CrewAI to track per-agent cost attribution.

    CrewAI uses LangChain chat models under the hood, so this wraps
    each CrewAI Agent's execution in a track() context for clean
    per-agent attribution.

    Usage:
        from tokimeter import Tracker
        from tokimeter.integrations import instrument_crewai

        tracker = Tracker("finops.db")
        instrument_crewai(tracker)

        # Also call instrument_langchain(tracker) to capture the actual LLM calls
        instrument_langchain(tracker)

        # Then use CrewAI normally
        from crewai import Agent, Task, Crew
        researcher = Agent(role="Researcher", ...)
        # When the crew runs, each agent's LLM calls are attributed to it
    """
    try:
        from crewai import Agent

        original_execute = Agent.execute_task

        @functools.wraps(original_execute)
        def patched_execute(self, task, *args, **kwargs):
            agent_name = getattr(self, "role", "crewai-agent") or "crewai-agent"
            # Use the tracker's context manager for attribution
            with tracker.track(agent_name=agent_name, workflow="crewai"):
                return original_execute(self, task, *args, **kwargs)

        Agent.execute_task = patched_execute
        logger.debug("Instrumented crewai.Agent")
        return True

    except ImportError:
        return False


# ─── Generic Framework Helper ────────────────────────────────────────────────


def track_agent_run(
    tracker: Tracker,
    agent_name: str,
    workflow: str = "default",
    customer: str = "",
):
    """
    Generic decorator for tracking an agent function.

    Works with ANY framework — wraps any function in a track() context
    so all LLM calls within it get attributed correctly.

    Usage:
        from tokimeter import Tracker
        from tokimeter.integrations import track_agent_run

        tracker = Tracker("finops.db")

        @track_agent_run(tracker, agent_name="support-bot")
        def handle_support_ticket(ticket_text: str) -> str:
            response = openai.chat.completions.create(...)
            return response.choices[0].message.content
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            with tracker.track(agent_name=agent_name, workflow=workflow, customer=customer):
                return func(*args, **kwargs)
        return wrapper
    return decorator


# ─── LiteLLM (universal proxy) ───────────────────────────────────────────────


def instrument_litellm(tracker: Tracker) -> bool:
    """
    Instrument LiteLLM to track all LLM calls regardless of provider.

    LiteLLM is a popular proxy that unifies 100+ LLM providers behind a
    single API. This patches litlitelm.completion() to capture token
    usage and cost.

    Usage:
        from tokimeter import Tracker
        from tokimeter.integrations import instrument_litellm

        tracker = Tracker("finops.db")
        instrument_litellm(tracker)

        import litellm
        response = litellm.completion(model="gpt-4o", messages=[...])
    """
    try:
        import litellm

        original_completion = litellm.completion

        @functools.wraps(original_completion)
        def patched_completion(*args, **kwargs):
            start = time.time()
            success = True
            error_msg = ""
            response = None

            try:
                response = original_completion(*args, **kwargs)
                return response
            except Exception as e:
                success = False
                error_msg = str(e)
                raise
            finally:
                latency = (time.time() - start) * 1000
                ctx = _get_context()

                input_tokens = 0
                output_tokens = 0
                model_name = kwargs.get("model", "")

                if response and hasattr(response, "usage"):
                    usage = response.usage
                    input_tokens = getattr(usage, "prompt_tokens", 0) or 0
                    output_tokens = getattr(usage, "completion_tokens", 0) or 0

                # Determine provider from model name
                provider = "unknown"
                if model_name.startswith("gpt") or model_name.startswith("o1") or model_name.startswith("o3"):
                    provider = "openai"
                elif "claude" in model_name:
                    provider = "anthropic"
                elif "gemini" in model_name:
                    provider = "google"

                tracker.record(
                    provider=provider,
                    model=model_name,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    latency_ms=latency,
                    success=success,
                    error=error_msg,
                    agent_name=ctx.get("agent_name", "litellm"),
                    workflow=ctx.get("workflow", "default"),
                )

        litellm.completion = patched_completion
        logger.debug("Instrumented litellm.completion")
        return True

    except ImportError:
        return False
