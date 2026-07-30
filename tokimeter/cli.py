"""
CLI interface for Tokimeter.

Usage:
    tokimeter report                    # show cost summary
    tokimeter report --agent support    # filter by agent
    tokimeter recommendations           # show optimization suggestions
    tokimeter dashboard                 # launch web dashboard
    tokimeter models                    # list known model pricing
    tokimeter demo                      # generate demo data and show report
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from shutil import which

from . import __version__
from .core import Tracker
from .pricing import Pricer
from .optimizer import Optimizer
from .models import LLMCall


_PROXY_COMMANDS = {
    "start",
    "stop",
    "status",
    "watch",
    "pricing",
    "config",
    "codex-import",
    "doctor",
    "ready",
    "uninstall",
    "restore",
    "claude",
    "codex",
    "codex-api",
    "codex-chatgpt",
    "openai",
    "aider",
    "cursor",
}
_PROXY_SETUP_TARGETS = {"all", "codex", "codex-api", "codex-chatgpt", "claude"}


def _repo_proxy_cli_path() -> Path:
    return Path(__file__).resolve().parent.parent / "ts" / "packages" / "proxy" / "src" / "cli.js"


def _should_delegate_to_proxy(argv: list[str]) -> bool:
    if not argv:
        return False

    command = argv[0]
    if command in _PROXY_COMMANDS:
        return True

    if command != "setup":
        return False

    setup_args = argv[1:]
    if "--auto" in setup_args or "--shims" in setup_args:
        return True

    target = next((arg for arg in setup_args if not arg.startswith("-")), "")
    return target in _PROXY_SETUP_TARGETS


def _run_proxy_cli(argv: list[str]) -> int:
    proxy_cli = _repo_proxy_cli_path()
    if proxy_cli.exists():
        return subprocess.call(["node", str(proxy_cli), *argv])

    tm_bin = which("tm")
    if tm_bin:
        return subprocess.call([tm_bin, *argv])

    print(_color("Tokimeter proxy wrapper is not installed.", "red"))
    print("Install it with: npm install -g @tokimeter/proxy")
    print("From this repo checkout, use: npm install -g ./ts/packages/proxy")
    return 1


def _db_path(args, default: str = "tokimeter.db") -> str:
    """Resolve either global --db or command-local --db."""
    return getattr(args, "command_db", "") or args.db or default


def _color(text: str, color: str) -> str:
    colors = {
        "red": "\033[91m", "green": "\033[92m", "yellow": "\033[93m",
        "blue": "\033[94m", "cyan": "\033[96m", "bold": "\033[1m",
        "dim": "\033[2m", "reset": "\033[0m",
    }
    return f"{colors.get(color, '')}{text}{colors['reset']}"


def cmd_report(args):
    """Show cost report from the database."""
    db_path = _db_path(args)

    if not Path(db_path).exists():
        print(_color(f"No database found at {db_path}", "red"))
        print("Run 'tokimeter demo' to generate sample data, or start tracking calls.")
        return 1

    tracker = Tracker(db_path=db_path)

    start = 0
    end = 0
    if args.days:
        end = time.time()
        start = end - (args.days * 86400)

    report = tracker.get_report(start_time=start, end_time=end)

    if report.total_calls == 0:
        print(_color("No calls found in the specified period.", "yellow"))
        return 0

    _print_report(report, args)

    if tracker._backend:
        tracker._backend.close()
    return 0


def cmd_recommendations(args):
    """Show cost optimization recommendations."""
    db_path = _db_path(args)

    if not Path(db_path).exists():
        print(_color(f"No database found at {db_path}", "red"))
        return 1

    tracker = Tracker(db_path=db_path)
    calls = tracker.get_calls()

    if not calls:
        print(_color("No calls to analyze.", "yellow"))
        return 0

    optimizer = Optimizer(tracker.pricer)
    recs = optimizer.analyze(calls)

    if not recs:
        print(_color("✓ No optimization opportunities found. Your spend looks efficient.", "green"))
        return 0

    total_savings = sum(r.estimated_savings_monthly for r in recs)

    print()
    print(_color(f"  💰 Optimization Recommendations", "bold"))
    print(_color(f"  Potential savings: ${total_savings:.2f}/mo", "green"))
    print(f"  {'─' * 58}")

    for i, rec in enumerate(recs, 1):
        sev_color = {"critical": "red", "warning": "yellow", "info": "cyan"}.get(rec.severity, "dim")
        sev_label = {"critical": "CRITICAL", "warning": "WARNING", "info": "INFO"}.get(rec.severity, "")

        print()
        print(f"  {_color(f'[{sev_label}]', sev_color)} {_color(rec.title, 'bold')}")
        print(f"  {_color(f'Save ${rec.estimated_savings_monthly:.2f}/mo', 'green')}")
        print(f"  {_color(rec.description, 'dim')}")
        print(f"  → {_color(rec.action, 'cyan')}")

    print()
    return 0


def cmd_models(args):
    """List known model pricing."""
    pricer = Pricer()
    models = pricer.list_models(provider=args.provider)

    print()
    print(_color("  Known Model Pricing (per 1M tokens)", "bold"))
    print(f"  {'─' * 64}")
    print(f"  {'Provider':<12} {'Model':<28} {'Input':>8} {'Output':>8} {'Cached':>8}")
    print(f"  {'─' * 64}")

    for m in models:
        cached = f"${m.cached_input_per_1m:.4g}" if m.cached_input_per_1m else "—"
        print(f"  {m.provider:<12} {m.model:<28} ${m.input_per_1m:<7.4g} ${m.output_per_1m:<7.4g} {cached:>8}")

    print()
    return 0


def cmd_demo(args):
    """Generate demo data and show report + recommendations."""
    db_path = _db_path(args, "tokimeter_demo.db")

    # Remove old demo db
    p = Path(db_path)
    if p.exists():
        p.unlink()

    print(_color("\n  Generating demo data...", "cyan"))

    tracker = Tracker(db_path=db_path)
    now = time.time()

    # Simulate a realistic multi-agent setup over 7 days
    agents_and_calls = [
        # Customer support triage - heavy volume, using GPT-4o (expensive!)
        ("support-triage", "gpt-4o", "openai", 145, 320, 800),
        # Sales qualification - moderate volume, Claude Sonnet
        ("sales-sdr", "claude-sonnet-4", "anthropic", 62, 850, 240),
        # Doc summarizer - high volume, Claude Opus (overkill!)
        ("doc-summarizer", "claude-opus-4", "anthropic", 38, 4200, 350),
        # Code reviewer - moderate, GPT-4o
        ("code-review", "gpt-4o", "openai", 28, 1800, 450),
        # Content generator - high volume, Gemini Flash (efficient!)
        ("content-gen", "gemini-2.5-flash", "google", 210, 150, 300),
        # Research agent - moderate, GPT-4o
        ("research", "gpt-4o", "openai", 18, 2200, 600),
    ]

    import random
    random.seed(42)

    total_calls = 0
    for agent_name, model, provider, count, avg_input, avg_output in agents_and_calls:
        for i in range(count):
            # Spread over 7 days
            ts = now - random.uniform(0, 7 * 86400)

            # Add variance to token counts
            input_tokens = int(avg_input * random.uniform(0.5, 2.0))
            output_tokens = int(avg_output * random.uniform(0.4, 1.8))

            # Some calls fail
            success = random.random() > 0.05
            error = "" if success else "Rate limit exceeded"

            # Occasional anomaly (5x normal)
            if random.random() < 0.05:
                input_tokens = int(input_tokens * 5)

            # Calculate cost manually and build call directly
            in_cost, out_cost, total_cost = tracker.pricer.price_call(
                model, input_tokens, output_tokens, 0, provider
            )
            call = LLMCall(
                timestamp=ts,
                provider=provider,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                input_cost=in_cost,
                output_cost=out_cost,
                total_cost=total_cost,
                agent_name=agent_name,
                workflow="production",
                customer="demo-corp",
                success=success,
                error=error,
                latency_ms=random.uniform(200, 3000),
            )
            tracker.record_call(call)
            total_calls += 1

    print(_color(f"  ✓ Generated {total_calls} demo calls across {len(agents_and_calls)} agents", "green"))

    # Show report
    report = tracker.get_report(start_time=now - 7 * 86400)
    _print_report(report, args)

    # Show recommendations
    print()
    calls = tracker.get_calls()
    optimizer = Optimizer(tracker.pricer)
    recs = optimizer.analyze(calls, period_days=7)

    if recs:
        total_savings = sum(r.estimated_savings_monthly for r in recs)
        print(_color(f"  💰 Optimization Recommendations", "bold"))
        print(_color(f"  Potential savings: ${total_savings:.2f}/mo", "green"))
        print(f"  {'─' * 58}")

        for rec in recs:
            sev_color = {"critical": "red", "warning": "yellow", "info": "cyan"}.get(rec.severity, "dim")
            sev_label = {"critical": "CRITICAL", "warning": "WARNING", "info": "INFO"}.get(rec.severity, "")

            print()
            print(f"  {_color(f'[{sev_label}]', sev_color)} {_color(rec.title, 'bold')}")
            print(f"  {_color(f'Save ${rec.estimated_savings_monthly:.2f}/mo', 'green')}")
            print(f"  {_color(rec.description, 'dim')}")
            print(f"  → {_color(rec.action, 'cyan')}")

    print()
    print(_color(f"  Demo database saved to: {db_path}", "dim"))
    print(_color(f"  Run 'tokimeter dashboard --db {db_path}' to view the web dashboard.", "dim"))
    print()
    return 0


def cmd_dashboard(args):
    """Launch the web dashboard."""
    from .dashboard import launch_dashboard

    db_path = _db_path(args)
    if not Path(db_path).exists():
        print(_color(f"No database found at {db_path}.", "red"))
        print("Run 'tokimeter demo' first to generate sample data.")
        return 1

    port = args.port or 8747
    launch_dashboard(db_path=db_path, port=port)
    return 0


def _print_report(report, args):
    """Pretty-print a cost report."""
    print()
    print(_color("  ╔═══════════════════════════════════════════════════════════════╗", "bold"))
    print(_color("  ║                    Tokimeter Cost Report                    ║", "bold"))
    print(_color("  ╚═══════════════════════════════════════════════════════════════╝", "bold"))

    print()
    print(f"  {_color('Priced Total:', 'bold')}   {_color(f'${report.total_cost:.4f}', 'yellow')} "
          f"({_color(f'{report.total_calls} calls', 'dim')})")
    if report.unpriced_calls:
        print(f"  {_color('Unknown Rough:', 'dim')}   ~${report.rough_estimate_cost:.4f} "
              f"({_color(f'{report.unpriced_calls} calls; excluded', 'dim')})")
    print(f"  {_color('Input Cost:', 'dim')}      ${report.total_input_cost:.4f}")
    print(f"  {_color('Output Cost:', 'dim')}     ${report.total_output_cost:.4f}")
    print(f"  {_color('Input Tokens:', 'dim')}    {report.total_input_tokens:,}")
    print(f"  {_color('Output Tokens:', 'dim')}   {report.total_output_tokens:,}")
    print(f"  {_color('Avg Cost/Call:', 'dim')}   ${report.total_cost / max(report.total_calls, 1):.6f}")

    if report.pricing_sources:
        labels = {
            "verified": "verified built-in",
            "custom": "custom local",
            "reported": "provider/tool reported",
            "fallback": "fallback / unpriced",
            "internal": "internal / unpriced",
        }
        source_text = " · ".join(
            f"{labels.get(source, source)} {count}"
            for source, count in sorted(report.pricing_sources.items())
        )
        print(f"  {_color('Price Sources:', 'dim')}    {source_text}")

    if report.by_agent:
        print()
        print(_color("  By Agent:", "bold"))
        for agent, cost in sorted(report.by_agent.items(), key=lambda x: -x[1]):
            pct = cost / report.total_cost * 100 if report.total_cost else 0
            bar = "█" * int(pct / 4)
            print(f"    {agent:<22} {_color(f'${cost:.4f}', 'yellow')} ({pct:.1f}%) {bar}")

    if report.by_model:
        print()
        print(_color("  By Model:", "bold"))
        for model, cost in sorted(report.by_model.items(), key=lambda x: -x[1]):
            pct = cost / report.total_cost * 100 if report.total_cost else 0
            print(f"    {model:<30} {_color(f'${cost:.4f}', 'yellow')} ({pct:.1f}%)")

    if report.by_provider:
        print()
        print(_color("  By Provider:", "bold"))
        for provider, cost in sorted(report.by_provider.items(), key=lambda x: -x[1]):
            pct = cost / report.total_cost * 100 if report.total_cost else 0
            print(f"    {provider:<14} {_color(f'${cost:.4f}', 'yellow')} ({pct:.1f}%)")

    if report.by_day and len(report.by_day) > 1:
        print()
        print(_color("  Daily Spend:", "bold"))
        max_cost = max(report.by_day.values()) if report.by_day else 1
        for day, cost in sorted(report.by_day.items()):
            bar = "█" * max(1, int(cost / max_cost * 30))
            print(f"    {day}  {_color(f'${cost:.4f}', 'yellow')} {bar}")

    print()


def cmd_setup(args):
    """Configure Supabase backend interactively."""
    import os

    print()
    print(_color("  🔧 Tokimeter Setup Wizard", "bold"))
    print(f"  {'─' * 58}")
    print()
    print("  Choose your storage backend:")
    print(f"    {_color('1', 'cyan')}) SQLite (local, zero config — default)")
    print(f"    {_color('2', 'cyan')}) Supabase (cloud Postgres — for teams)")
    print()

    choice = input(_color("  Select [1/2]: ", "bold")).strip() or "1"

    if choice == "2":
        print()
        print(_color("  Setting up Supabase...", "cyan"))
        print()
        print("  1. Create a free project at https://supabase.com")
        print("  2. Go to Dashboard → SQL → New Query")
        print("  3. Paste the contents of supabase_schema.sql and click Run")
        print("  4. Go to Dashboard → Settings → API")
        print("     Copy the Project URL and anon public key")
        print()

        url = args.url or input("  Project URL: ").strip()
        key = args.key or input("  Anon Key: ").strip()

        if not url or not key:
            print(_color("  ✗ URL and key are required.", "red"))
            return 1

        # Test the connection
        print()
        print(_color("  Testing connection...", "cyan"))
        try:
            from .backends import SupabaseStore
            store = SupabaseStore(url=url, key=key)
            count = store.count()
            print(_color(f"  ✓ Connected! Table has {count} records.", "green"))
        except Exception as e:
            print(_color(f"  ✗ Connection failed: {e}", "red"))
            print("  Make sure you ran the schema SQL in Supabase.")
            return 1

        # Write config file
        config_path = os.path.expanduser("~/.tokimeter.env")
        with open(config_path, "w") as f:
            f.write(f"TOKIMETER_SUPABASE_URL={url}\n")
            f.write(f"TOKIMETER_SUPABASE_KEY={key}\n")

        print()
        print(_color(f"  ✓ Config saved to {config_path}", "green"))
        print(_color("  To use in Python:", "bold"))
        print(f"    export TOKIMETER_SUPABASE_URL={url}")
        print(f"    export TOKIMETER_SUPABASE_KEY={key}")
        print(f"    python3 -c \"from tokimeter import Tracker; t = Tracker(); print('Ready!')\"")
        print()
    else:
        print()
        print(_color("  ✓ SQLite mode — no setup needed!", "green"))
        print(_color("  Just use Tokimeter with a file path:", "bold"))
        print("    from tokimeter import Tracker")
        print('    tracker = Tracker("finops.db")')
        print()
        print(_color("  Or run the demo:", "bold"))
        print("    tokimeter demo")
        print()

    return 0


def cmd_budgets(args):
    """Check budget status."""
    db_path = _db_path(args)

    if not Path(db_path).exists():
        print(_color(f"No database found at {db_path}", "red"))
        return 1

    tracker = Tracker(db_path=db_path)
    report = tracker.get_report()

    print()
    print(_color("  💰 Budget Status", "bold"))
    print(f"  {'─' * 50}")
    print(f"  Priced spend: {_color(f'${report.total_cost:.2f}', 'yellow')}")
    if report.unpriced_calls:
        print(f"  Unknown-model rough: ~${report.rough_estimate_cost:.2f} "
              f"({report.unpriced_calls} calls; excluded)")
    print()
    print("  To set up budget alerts, see: tokimeter/alerts.py")
    print()

    if tracker._backend:
        tracker._backend.close()
    return 0


def cmd_hosted(args):
    """Run hosted SaaS scaffold commands."""
    from .hosted import HostedStore, launch_hosted_api

    db_path = _db_path(args, "tokimeter_hosted.db")

    if args.hosted_command == "init":
        store = HostedStore(db_path)
        try:
            result = store.bootstrap(args.org, args.email, args.project)
        finally:
            store.close()
        print(json.dumps(result, indent=2))
        return 0

    if args.hosted_command == "serve":
        launch_hosted_api(db_path=db_path, host=args.host, port=args.port)
        return 0

    print(_color("Missing hosted command. Use: tokimeter hosted init|serve", "red"))
    return 1


def main():
    raw_args = sys.argv[1:]
    if _should_delegate_to_proxy(raw_args):
        return _run_proxy_cli(raw_args)

    parser = argparse.ArgumentParser(
        prog="tokimeter",
        description="FinOps for AI agents — track, attribute, and optimize LLM spend.",
    )
    parser.add_argument("--version", action="version", version=f"tokimeter {__version__}")
    parser.add_argument("--db", default="", help="Path to the database file")

    subparsers = parser.add_subparsers(dest="command")

    # report
    p_report = subparsers.add_parser("report", help="Show cost report")
    p_report.add_argument("--db", dest="command_db", default="", help="Path to the database file")
    p_report.add_argument("--days", type=int, default=0, help="Number of days to look back")
    p_report.add_argument("--agent", default="", help="Filter by agent name")

    # recommendations
    p_recs = subparsers.add_parser("recs", help="Show cost optimization recommendations")
    p_recs.add_argument("--db", dest="command_db", default="", help="Path to the database file")
    p_recommendations = subparsers.add_parser("recommendations", help="Alias for 'recs'")
    p_recommendations.add_argument("--db", dest="command_db", default="", help="Path to the database file")

    # models
    p_models = subparsers.add_parser("models", help="List known model pricing")
    p_models.add_argument("--provider", default="", help="Filter by provider")

    # demo
    p_demo = subparsers.add_parser("demo", help="Generate demo data and show report")
    p_demo.add_argument("--db", dest="command_db", default="", help="Path to the database file")
    p_demo.add_argument("--days", type=int, default=7, help="Demo period in days")

    # dashboard
    p_dash = subparsers.add_parser("dashboard", help="Launch web dashboard")
    p_dash.add_argument("--db", dest="command_db", default="", help="Path to the database file")
    p_dash.add_argument("--port", type=int, default=8747, help="Dashboard port")

    # setup
    p_setup = subparsers.add_parser("setup", help="Configure Supabase backend")
    p_setup.add_argument("--url", default="", help="Supabase project URL")
    p_setup.add_argument("--key", default="", help="Supabase anon/service key")

    # budgets
    p_budget = subparsers.add_parser("budgets", help="Check budget status")
    p_budget.add_argument("--db", dest="command_db", default="", help="Database path")

    # hosted
    p_hosted = subparsers.add_parser("hosted", help="Hosted SaaS scaffold")
    p_hosted.add_argument("--db", dest="command_db", default="", help="Hosted database path")
    hosted_sub = p_hosted.add_subparsers(dest="hosted_command")
    p_hosted_init = hosted_sub.add_parser("init", help="Create first org/project/API key")
    p_hosted_init.add_argument("--org", required=True, help="Organization name")
    p_hosted_init.add_argument("--email", required=True, help="Owner email")
    p_hosted_init.add_argument("--project", default="default", help="Project name")
    p_hosted_serve = hosted_sub.add_parser("serve", help="Run hosted API")
    p_hosted_serve.add_argument("--host", default="127.0.0.1", help="Bind host")
    p_hosted_serve.add_argument("--port", type=int, default=8789, help="Bind port")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 0

    if args.command in ("report",):
        return cmd_report(args)
    elif args.command in ("recs", "recommendations"):
        return cmd_recommendations(args)
    elif args.command == "models":
        return cmd_models(args)
    elif args.command == "demo":
        return cmd_demo(args)
    elif args.command == "dashboard":
        return cmd_dashboard(args)
    elif args.command == "setup":
        return cmd_setup(args)
    elif args.command == "budgets":
        return cmd_budgets(args)
    elif args.command == "hosted":
        return cmd_hosted(args)

    return 0


if __name__ == "__main__":
    sys.exit(main())
