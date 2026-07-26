"""
Tokimeter — FinOps for AI agents.

Track, attribute, and optimize LLM spend across your agent workflows.
Zero dependencies, drop-in instrumentation for OpenAI, Anthropic, Google Gemini,
LangChain, CrewAI, and LiteLLM. SQLite for solo devs, Supabase for teams.
"""

from .core import Tracker, track, current_tracker
from .pricing import Pricer, MODEL_PRICING
from .models import LLMCall, AgentRun, CostReport, Recommendation
from .optimizer import Optimizer
from .async_writer import AsyncWriter
from .alerts import BudgetMonitor, Budget, SlackNotifier, EmailNotifier, WebhookNotifier, DiscordNotifier
from .backends import create_backend, SQLiteStore, SupabaseStore

# Hosted SaaS scaffold (future Pro tier) is intentionally NOT imported eagerly —
# the local-first core must not load it. Lazy access keeps back-compat:
# `from tokimeter import HostedStore` still works via PEP 562 __getattr__.


def __getattr__(name):
    if name in ("HostedStore", "launch_hosted_api"):
        from . import hosted
        return getattr(hosted, name)
    raise AttributeError(f"module 'tokimeter' has no attribute {name!r}")


__version__ = "0.2.0"
__all__ = [
    # Core
    "Tracker",
    "track",
    "current_tracker",
    # Pricing
    "Pricer",
    "MODEL_PRICING",
    # Models
    "LLMCall",
    "AgentRun",
    "CostReport",
    "Recommendation",
    # Optimizer
    "Optimizer",
    # Async
    "AsyncWriter",
    # Alerts
    "BudgetMonitor",
    "Budget",
    "SlackNotifier",
    "EmailNotifier",
    "WebhookNotifier",
    "DiscordNotifier",
    # Backends
    "create_backend",
    "SQLiteStore",
    "SupabaseStore",
    "HostedStore",
    "launch_hosted_api",
]
