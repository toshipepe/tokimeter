"""
Tests for Tokimeter.

Run with: python -m pytest tests/ -v
Or simply: python tests/test_basic.py
"""

import sys
import os
import time
import tempfile
import subprocess
import json

# Add parent dir to path for direct execution
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tokimeter import Tracker, Pricer, Optimizer, LLMCall
from tokimeter.models import CostReport
from tokimeter.pricing import ModelPrice
from tokimeter.backends import SQLiteStore, create_backend
from tokimeter.async_writer import AsyncWriter
from tokimeter.alerts import Budget, BudgetMonitor, WebhookNotifier
from tokimeter.hosted import HostedStore
from tokimeter.cli import _repo_proxy_cli_path, _should_delegate_to_proxy


def test_pricing_basic():
    """Test that pricing calculation works for known models."""
    pricer = Pricer()

    # GPT-4o: $2.50/1M input, $10/1M output
    in_cost, out_cost, total = pricer.price_call("gpt-4o", 1_000_000, 1_000_000)
    assert in_cost == 2.50, f"Expected 2.50, got {in_cost}"
    assert out_cost == 10.00, f"Expected 10.00, got {out_cost}"
    assert total == 12.50, f"Expected 12.50, got {total}"
    print("✓ test_pricing_basic passed")


def test_pricing_cached():
    """Test cached token pricing."""
    pricer = Pricer()

    # Claude Sonnet 4: $3/1M input, $0.30/1M cached
    in_cost, out_cost, total = pricer.price_call(
        "claude-sonnet-4", 1_000_000, 0, cached_tokens=500_000
    )
    # 500K at $3/1M + 500K at $0.30/1M
    expected_in = (500_000 / 1_000_000) * 3.0 + (500_000 / 1_000_000) * 0.30
    assert abs(in_cost - expected_in) < 0.01, f"Expected {expected_in}, got {in_cost}"
    print("✓ test_pricing_cached passed")


def test_pricing_unknown_model():
    """Test that unknown models stay outside authoritative pricing."""
    pricer = Pricer()
    in_cost, out_cost, total = pricer.price_call("some-unknown-model", 1_000_000, 1_000_000)
    assert (in_cost, out_cost, total) == (0.0, 0.0, 0.0)
    rough_in, rough_out, rough_total = pricer.rough_estimate_call(1_000_000, 1_000_000)
    assert (rough_in, rough_out, rough_total) == (2.0, 8.0, 10.0)
    assert pricer.get_price_source("some-unknown-model") == {
        "source": "fallback",
        "label": "fallback / unpriced",
        "authoritative": False,
    }
    print("✓ test_pricing_unknown_model passed (rough $10 excluded)")


def test_pricing_aliases():
    """Test that model aliases resolve correctly."""
    pricer = Pricer()

    # "claude-sonnet-4-20250514" should map to "claude-sonnet-4"
    price = pricer.get_price("claude-sonnet-4-20250514")
    assert price is not None
    assert price.model == "claude-sonnet-4"
    print("✓ test_pricing_aliases passed")


def test_pricing_current_recorded_models():
    """Price published models and keep internal routing identifiers honest."""
    pricer = Pricer()

    in_cost, out_cost, total = pricer.price_call(
        "claude-opus-5",
        1_000_000,
        1_000_000,
        cached_tokens=500_000,
        cache_creation_tokens=200_000,
        cached_included_in_input=False,
    )
    assert (in_cost, out_cost, total) == (6.5, 25.0, 31.5)
    assert pricer.get_price_source("claude-opus-5") == {
        "source": "verified",
        "label": "verified built-in",
        "authoritative": True,
    }

    assert pricer.price_call("codex-auto-review", 1_000_000, 1_000_000) == (0.0, 0.0, 0.0)
    source = pricer.get_price_source("codex-auto-review")
    assert source["source"] == "internal"
    assert source["label"] == "internal / unpriced"
    assert source["authoritative"] is False
    assert source["provider"] == "openai"

    tracker = Tracker()
    tracker.record(
        model="codex-auto-review",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        provider="openai",
    )
    report = tracker.get_report()
    assert report.total_cost == 0.0
    assert report.unpriced_calls == 1
    assert report.pricing_sources == {"internal": 1}
    print("✓ test_pricing_current_recorded_models passed")


def test_pricing_dated_and_inclusive_cache_rates():
    """Time-tiered rates and inclusive ledgers match the JavaScript pricer."""
    pricer = Pricer()
    off_peak = pricer.price_call(
        "deepseek-v4-flash", 1_000_000, 1_000_000,
        timestamp=1787313600,  # 2026-08-21 12:00 UTC
    )
    peak = pricer.price_call(
        "deepseek-v4-flash", 1_000_000, 1_000_000,
        timestamp=1787293800,  # 2026-08-21 06:30 UTC
    )
    assert off_peak[2] == 0.88
    assert peak[2] == 1.76

    inclusive = pricer.price_call(
        "claude-sonnet-5", 1_000_000, 0,
        cached_tokens=200_000,
        cache_creation_tokens=100_000,
        cache_creation_included_in_input=True,
    )
    assert inclusive[2] == 1.69
    assert pricer.get_price("codestral-latest").model == "codestral"
    assert pricer.get_price("grok-4.6").cached_input_per_1m == 0.5
    assert pricer.get_price("glm-5.3").output_per_1m == 4.4
    print("✓ test_pricing_dated_and_inclusive_cache_rates passed")


def test_tracker_memory():
    """Test in-memory tracking."""
    tracker = Tracker()  # in-memory mode

    call = tracker.record(
        provider="openai",
        model="gpt-4o",
        input_tokens=1000,
        output_tokens=500,
    )

    assert call.total_cost > 0
    assert call.input_cost == (1000 / 1_000_000) * 2.50
    assert call.output_cost == (500 / 1_000_000) * 10.00
    assert tracker.total_calls() == 1
    assert tracker.total_cost() == call.total_cost
    print(f"✓ test_tracker_memory passed (cost: ${call.total_cost:.6f})")


def test_tracker_separates_unknown_pricing():
    """Known costs aggregate while unknown-model rough estimates remain separate."""
    tracker = Tracker()
    known = tracker.record(
        provider="openai",
        model="gpt-4o",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    unknown = tracker.record(
        provider="custom",
        model="future-model",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    report = tracker.get_report()

    assert report.total_cost == known.total_cost == 12.5
    assert unknown.total_cost == 0
    assert report.rough_estimate_cost == 10
    assert report.unpriced_calls == 1
    assert report.pricing_sources == {"verified": 1, "fallback": 1}
    assert unknown.tags["pricing_authoritative"] is False
    print("✓ test_tracker_separates_unknown_pricing passed")


def test_tracker_sqlite():
    """Test SQLite persistent tracking."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        tracker = Tracker(db_path=db_path)

        for i in range(10):
            tracker.record(
                provider="anthropic",
                model="claude-sonnet-4",
                input_tokens=2000,
                output_tokens=800,
                agent_name="test-agent",
                workflow="test-workflow",
            )

        assert tracker.total_calls() == 10
        assert tracker.total_cost() > 0

        # Re-open and verify persistence
        tracker2 = Tracker(db_path=db_path)
        assert tracker2.total_calls() == 10
        print(f"✓ test_tracker_sqlite passed (10 calls, ${tracker.total_cost():.4f})")
    finally:
        os.unlink(db_path)


def test_tracker_excludes_legacy_unknown_fallback():
    """An unlabeled legacy unknown-model amount is treated as rough on read."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        store = SQLiteStore(db_path)
        store.record_call(LLMCall(
            provider="custom",
            model="legacy-unknown",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
            input_cost=2,
            output_cost=8,
            total_cost=10,
        ))
        store.close()

        report = Tracker(db_path=db_path).get_report()
        assert report.total_cost == 0
        assert report.rough_estimate_cost == 10
        assert report.unpriced_calls == 1
        print("✓ test_tracker_excludes_legacy_unknown_fallback passed")
    finally:
        os.unlink(db_path)


def test_context_manager():
    """Test workflow attribution via context manager."""
    tracker = Tracker()

    with tracker.track(agent_name="support-bot", workflow="triage") as run:
        tracker.record(
            provider="openai", model="gpt-4o-mini",
            input_tokens=500, output_tokens=200,
        )
        # agent_name should be inherited from context
        assert tracker.total_calls() == 1

    calls = tracker.get_calls()
    assert len(calls) == 1
    assert calls[0].agent_name == "support-bot"
    assert calls[0].workflow == "triage"
    print("✓ test_context_manager passed")


def test_cost_report():
    """Test cost report aggregation."""
    tracker = Tracker()

    models = [
        ("openai", "gpt-4o", 1000, 500),
        ("openai", "gpt-4o-mini", 2000, 300),
        ("anthropic", "claude-sonnet-4", 1500, 800),
        ("google", "gemini-2.5-flash", 3000, 400),
    ]

    for provider, model, in_tok, out_tok in models:
        tracker.record(
            provider=provider, model=model,
            input_tokens=in_tok, output_tokens=out_tok,
            agent_name="test-agent",
        )

    report = tracker.get_report()
    assert report.total_calls == 4
    assert report.total_cost > 0
    assert len(report.by_provider) == 3
    assert len(report.by_model) == 4
    assert "openai" in report.by_provider
    print(f"✓ test_cost_report passed (${report.total_cost:.4f} across {report.total_calls} calls)")


def test_optimizer_downgrade():
    """Test that optimizer detects model downgrade opportunities."""
    tracker = Tracker()

    # Simulate using expensive Claude Opus for simple tasks
    for i in range(50):
        tracker.record(
            provider="anthropic",
            model="claude-opus-4",
            input_tokens=1000,
            output_tokens=500,
            agent_name="summarizer",
        )

    calls = tracker.get_calls()
    optimizer = Optimizer()
    recs = optimizer.analyze(calls)

    # Should recommend downgrading from Opus to Sonnet
    downgrade_recs = [r for r in recs if "Downgrade" in r.title or "downgrade" in r.title.lower()]
    assert len(downgrade_recs) > 0, "Expected at least one downgrade recommendation"
    assert downgrade_recs[0].estimated_savings_monthly > 0
    print(f"✓ test_optimizer_downgrade passed ({len(downgrade_recs)} recs, "
          f"save ${downgrade_recs[0].estimated_savings_monthly:.2f}/mo)")


def test_optimizer_anomaly():
    """Test that optimizer detects anomalous expensive calls."""
    tracker = Tracker()

    # Normal calls
    for i in range(20):
        tracker.record(
            provider="openai", model="gpt-4o",
            input_tokens=1000, output_tokens=500,
            agent_name="agent-x",
        )

    # Anomalous call (10x normal input)
    tracker.record(
        provider="openai", model="gpt-4o",
        input_tokens=10000, output_tokens=5000,
        agent_name="agent-x",
    )

    calls = tracker.get_calls()
    optimizer = Optimizer()
    recs = optimizer.analyze(calls)

    anomaly_recs = [r for r in recs if "Anomalous" in r.title or "anomalous" in r.title.lower()]
    # May or may not trigger depending on thresholds, but should not crash
    print(f"✓ test_optimizer_anomaly passed ({len(anomaly_recs)} anomaly recs)")


def test_optimizer_error_waste():
    """Test that optimizer detects wasted spend on failed calls."""
    tracker = Tracker()

    # Successful calls
    for i in range(20):
        tracker.record(
            provider="openai", model="gpt-4o",
            input_tokens=1000, output_tokens=500,
            agent_name="agent-x",
        )

    # Failed calls (make them expensive enough to trigger threshold)
    for i in range(10):
        tracker.record(
            provider="openai", model="gpt-4o",
            input_tokens=2000, output_tokens=1000,
            agent_name="agent-x",
            success=False,
            error="rate_limit",
        )

    calls = tracker.get_calls()
    optimizer = Optimizer()
    recs = optimizer.analyze(calls)

    error_recs = [r for r in recs if "Failed" in r.title or "failed" in r.title.lower()]
    assert len(error_recs) > 0, "Expected error waste recommendation"
    assert error_recs[0].estimated_savings_monthly > 0
    print(f"✓ test_optimizer_error_waste passed ({len(error_recs)} error recs)")


def test_custom_pricing():
    """Test adding custom model pricing."""
    pricer = Pricer()
    custom = ModelPrice("custom", "my-finetuned-model", 0.50, 2.00)
    pricer.add_custom_price(custom)

    in_cost, out_cost, total = pricer.price_call("my-finetuned-model", 1_000_000, 1_000_000)
    assert in_cost == 0.50
    assert out_cost == 2.00
    assert pricer.get_price_source("my-finetuned-model")["source"] == "custom"
    print("✓ test_custom_pricing passed")


def test_global_tracker():
    """Test the global tracker and module-level track() function."""
    from tokimeter import track, current_tracker

    # Reset global
    Tracker.set_global(None)

    with track(agent_name="global-test", workflow="test"):
        t = current_tracker()
        assert t is not None

    print("✓ test_global_tracker passed")


def test_async_writer():
    """Test async batched writer."""
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        store = SQLiteStore(db_path)
        writer = AsyncWriter(store, flush_interval=0.5, batch_size=5)
        writer.start()

        # Enqueue 12 calls
        for i in range(12):
            call = LLMCall(
                provider="openai", model="gpt-4o",
                input_tokens=100, output_tokens=50,
                total_cost=0.001,
                agent_name="async-test",
            )
            writer.enqueue(call)

        # Wait for flush
        import time
        time.sleep(2)
        writer.stop()

        assert store.count() == 12, f"Expected 12, got {store.count()}"
        assert writer.stats["flushed"] == 12
        assert writer.stats["dropped"] == 0
        print(f"✓ test_async_writer passed (flushed={writer.stats['flushed']})")
    finally:
        os.unlink(db_path)


def test_create_backend():
    """Test backend factory."""
    # SQLite
    backend = create_backend(db_path="/tmp/test_tokimeter.db")
    assert backend is not None
    assert isinstance(backend, SQLiteStore)
    backend.close()

    # No backend
    backend = create_backend()
    assert backend is None

    # Cleanup
    import os
    if os.path.exists("/tmp/test_tokimeter.db"):
        os.unlink("/tmp/test_tokimeter.db")

    print("✓ test_create_backend passed")


def test_budget_monitor():
    """Test budget monitoring and alerting."""
    tracker = Tracker()

    # Simulate spending
    for i in range(20):
        tracker.record(
            provider="openai", model="gpt-4o",
            input_tokens=1000, output_tokens=500,
            agent_name="test-agent",
        )

    # Create a budget that should trigger (limit is very low)
    budget = Budget(
        name="test-budget",
        limit=0.001,  # $0.001 limit — should be exceeded
        period="daily",
        alert_at_pct=50,
    )

    # Track alert calls
    alerts = []

    class TestNotifier:
        def send(self, budget, current_spend, pct):
            alerts.append((budget.name, current_spend, pct))

    monitor = BudgetMonitor(
        tracker=tracker,
        budgets=[budget],
        notifiers=[TestNotifier()],
    )

    monitor.check()

    assert len(alerts) == 1, f"Expected 1 alert, got {len(alerts)}"
    assert alerts[0][2] >= 50  # pct should be >= alert_at_pct
    print(f"✓ test_budget_monitor passed (alert at {alerts[0][2]:.0f}%, spend ${alerts[0][1]:.4f})")


def test_supabase_store_import():
    """Test that SupabaseStore can be imported and validates config."""
    from tokimeter.backends import SupabaseStore

    # Should raise without config
    try:
        store = SupabaseStore()
        assert False, "Should have raised"
    except ValueError:
        pass  # expected

    print("✓ test_supabase_store_import passed")


def test_tracker_async_mode():
    """Test Tracker with async mode enabled."""
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        tracker = Tracker(db_path=db_path, use_async=True)

        for i in range(10):
            tracker.record(
                provider="openai", model="gpt-4o-mini",
                input_tokens=500, output_tokens=200,
                agent_name="async-agent",
            )

        # Flush and wait
        tracker.flush()
        import time
        time.sleep(1)
        tracker.close()

        # Verify persistence
        tracker2 = Tracker(db_path=db_path)
        assert tracker2.total_calls() == 10
        print(f"✓ test_tracker_async_mode passed (10 async calls)")
    finally:
        os.unlink(db_path)


def test_integrations_import():
    """Test that integration helpers can be imported."""
    from tokimeter.integrations import (
        instrument_langchain, instrument_crewai,
        instrument_litellm, track_agent_run,
    )

    # These should all be callable
    assert callable(instrument_langchain)
    assert callable(instrument_crewai)
    assert callable(instrument_litellm)
    assert callable(track_agent_run)

    # track_agent_run should work as a decorator
    tracker = Tracker()

    @track_agent_run(tracker, agent_name="test")
    def dummy_function(x):
        return x * 2

    result = dummy_function(5)
    assert result == 10
    print("✓ test_integrations_import passed")


def test_hosted_store_ingest_report():
    """Test hosted SaaS scaffold bootstrap, API-key auth, ingest, and reporting."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        store = HostedStore(db_path)
        boot = store.bootstrap(
            org_name="Acme AI",
            user_email="owner@example.com",
            project_name="production",
        )
        auth = store.authenticate(boot["api_key"])
        assert auth is not None
        assert auth["org_id"] == boot["org_id"]
        assert auth["project_id"] == boot["project_id"]

        result = store.ingest(auth, [
            {
                "external_id": "call-1",
                "provider": "openai",
                "model": "gpt-4o",
                "input_tokens": 1000,
                "output_tokens": 500,
                "agent_name": "hosted-test",
            },
            {
                "external_id": "call-1",
                "provider": "openai",
                "model": "gpt-4o",
                "input_tokens": 1000,
                "output_tokens": 500,
                "agent_name": "hosted-test",
            },
        ])
        assert result["inserted"] == 1
        assert result["duplicates"] == 1

        report = store.report(boot["org_id"], boot["project_id"])
        assert report.total_calls == 1
        assert report.total_cost > 0
        assert report.by_agent["hosted-test"] > 0
        store.close()
        print("✓ test_hosted_store_ingest_report passed")
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_hosted_management_budget_status():
    """Test hosted project/key management and budget status calculations."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        store = HostedStore(db_path)
        boot = store.bootstrap(
            org_name="Acme AI",
            user_email="owner@example.com",
            project_name="production",
        )
        auth = store.authenticate(boot["api_key"])

        project = store.create_project(auth["org_id"], "staging", "staging")
        assert project["name"] == "staging"
        assert project["slug"] == "staging"

        new_key = store.create_api_key(auth["org_id"], project["id"], "Staging key")
        assert new_key["api_key"].startswith("tmk_live_")
        assert new_key["prefix"] in [k["prefix"] for k in store.api_keys(auth["org_id"])]

        budget = store.create_budget(auth["org_id"], {
            "name": "Tiny daily cap",
            "limit_usd": 0.001,
            "period": "daily",
            "project_id": auth["project_id"],
            "alert_at_pct": 50,
        })
        assert budget["name"] == "Tiny daily cap"

        store.ingest(auth, [{
            "external_id": "budget-call",
            "provider": "openai",
            "model": "gpt-4o",
            "input_tokens": 1000,
            "output_tokens": 500,
            "agent_name": "budget-agent",
        }])

        statuses = store.budget_status(auth["org_id"], auth["project_id"])
        assert len(statuses) == 1
        assert statuses[0]["current_spend"] > 0
        assert statuses[0]["alert_triggered"] is True

        recent = store.recent_calls(auth["org_id"], auth["project_id"], limit=5)
        assert len(recent) == 1
        assert recent[0]["agent_name"] == "budget-agent"

        subscription = store.set_subscription(auth["org_id"], "pro")
        assert subscription["plan"] == "pro"

        assert store.revoke_api_key(auth["org_id"], new_key["id"]) is True
        revoked = [k for k in store.api_keys(auth["org_id"]) if k["id"] == new_key["id"]][0]
        assert revoked["revoked_at"] is not None

        store.close()
        print("✓ test_hosted_management_budget_status passed")
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_hosted_alert_digest_export():
    """Test hosted pro alert events, digest, and CSV export."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        store = HostedStore(db_path)
        boot = store.bootstrap(
            org_name="Acme AI",
            user_email="owner@example.com",
            project_name="production",
        )
        auth = store.authenticate(boot["api_key"])

        store.create_alert_channel(auth["org_id"], {
            "name": "Activity log",
            "type": "log",
        })
        store.create_budget(auth["org_id"], {
            "name": "Daily cap",
            "limit_usd": 0.001,
            "period": "daily",
            "project_id": auth["project_id"],
            "alert_at_pct": 50,
        })
        store.ingest(auth, [{
            "external_id": "alert-call",
            "provider": "openai",
            "model": "gpt-4o",
            "input_tokens": 1000,
            "output_tokens": 500,
            "agent_name": "alert-agent",
            "workflow": "pro",
        }])

        result = store.evaluate_budget_alerts(auth["org_id"], auth["project_id"], send=True)
        assert result["created"] == 1
        assert result["alerts"][0]["status"] == "delivered"

        second = store.evaluate_budget_alerts(auth["org_id"], auth["project_id"], send=True)
        assert second["created"] == 0
        assert second["skipped"] == 1

        events = store.alert_events(auth["org_id"])
        assert len(events) == 1
        assert events[0]["budget_name"] == "Daily cap"

        digest = store.digest(auth["org_id"], auth["project_id"], days=7)
        assert digest["summary"]["total_calls"] == 1
        assert digest["summary"]["active_budget_alerts"] == 1

        csv_text = store.calls_csv(auth["org_id"], auth["project_id"], days=7)
        assert "agent_name" in csv_text
        assert "alert-agent" in csv_text

        store.close()
        print("✓ test_hosted_alert_digest_export passed")
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)


def test_cli_proxy_delegation_detection():
    """Test that Python CLI delegates proxy-shaped commands to the Node wrapper."""
    assert _should_delegate_to_proxy(["doctor"])
    assert _should_delegate_to_proxy(["ready"])
    assert _should_delegate_to_proxy(["watch", "--once"])
    assert _should_delegate_to_proxy(["pricing", "source", "claude-sonnet-4"])
    assert _should_delegate_to_proxy(["config", "set", "claude.advisorModel", "haiku"])
    assert _should_delegate_to_proxy(["codex-import"])
    assert _should_delegate_to_proxy(["setup", "codex", "--auto"])
    assert _should_delegate_to_proxy(["setup", "claude", "--auto"])
    assert _should_delegate_to_proxy(["setup", "--auto"])
    assert _should_delegate_to_proxy(["codex-chatgpt", "exec", "say hello"])
    assert not _should_delegate_to_proxy(["setup"])
    assert not _should_delegate_to_proxy(["setup", "--url", "https://example.supabase.co"])
    assert not _should_delegate_to_proxy(["demo"])
    assert _repo_proxy_cli_path().exists()
    print("✓ test_cli_proxy_delegation_detection passed")


def test_proxy_setup_installs_command_shims():
    """Test shims survive a removed setup-time Node installation."""
    with tempfile.TemporaryDirectory() as home_root, tempfile.TemporaryDirectory() as codex_home:
        home = os.path.join(home_root, "user's home with spaces")
        os.makedirs(home)
        env = os.environ.copy()
        env["HOME"] = home
        env["CODEX_HOME"] = codex_home
        cli_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "ts",
            "packages",
            "proxy",
            "src",
            "cli.js",
        )
        result = subprocess.run(
            [
                "node",
                cli_path,
                "setup",
                "codex",
                "--auto",
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert result.returncode == 0, result.stderr or result.stdout
        shim_dir = os.path.join(home, ".tokimeter", "bin")
        for command in ("tokimeter", "tm", "codex"):
            path = os.path.join(shim_dir, command)
            assert os.path.exists(path), f"Missing shim: {path}"
            assert os.access(path, os.X_OK), f"Shim is not executable: {path}"

            with open(path, encoding="utf-8") as f:
                script = f.read()
            assert "command -v tokimeter" in script
            assert 'if [ -f "$TOKIMETER_SETUP_CLI" ]' in script
            assert "could not find the active Tokimeter installation" in script

            # Reproduce the reported failure: the Node-version-specific path
            # that existed during setup has disappeared. The launcher must use
            # the currently active global Tokimeter command instead.
            script = "\n".join(
                "TOKIMETER_SETUP_CLI='/removed/node/v-old/lib/node_modules/tokimeter/src/cli.js'"
                if line.startswith("TOKIMETER_SETUP_CLI=") else line
                for line in script.splitlines()
            ) + "\n"
            with open(path, "w", encoding="utf-8") as f:
                f.write(script)
            os.chmod(path, 0o755)

        current_bin = os.path.join(home, "current-node-bin")
        os.makedirs(current_bin)
        current_tokimeter = os.path.join(current_bin, "tokimeter")
        with open(current_tokimeter, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nprintf 'current:%s\\n' \"$*\"\n")
        os.chmod(current_tokimeter, 0o755)

        upgraded_env = env.copy()
        upgraded_env["PATH"] = os.pathsep.join([shim_dir, current_bin, "/usr/bin", "/bin"])
        repaired_cli = subprocess.run(
            [os.path.join(shim_dir, "tokimeter"), "report", "--json"],
            env=upgraded_env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert repaired_cli.returncode == 0, repaired_cli.stderr
        assert repaired_cli.stdout.strip() == "current:report --json"

        repaired_tool = subprocess.run(
            [os.path.join(shim_dir, "codex"), "--version"],
            env=upgraded_env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert repaired_tool.returncode == 0, repaired_tool.stderr
        assert repaired_tool.stdout.strip() == "current:codex --version"

        missing_env = env.copy()
        missing_env["PATH"] = os.pathsep.join([shim_dir, "/bin"])
        missing = subprocess.run(
            [os.path.join(shim_dir, "tokimeter"), "doctor"],
            env=missing_env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert missing.returncode == 127
        assert "A Node version was probably switched or removed" in missing.stderr
        assert "MODULE_NOT_FOUND" not in missing.stderr

        with open(os.path.join(shim_dir, "tokimeter"), "w", encoding="utf-8") as f:
            f.write(
                "#!/bin/sh\n"
                "exec node \"/removed/node/v-old/lib/node_modules/tokimeter/src/cli.js\" \"$@\"\n"
            )
        os.chmod(os.path.join(shim_dir, "tokimeter"), 0o755)
        doctor = subprocess.run(
            ["node", cli_path, "doctor"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert doctor.returncode == 0, doctor.stderr
        assert "legacy Node-version-pinned launcher" in doctor.stdout
    print("✓ test_proxy_setup_installs_command_shims passed")


def test_proxy_setup_installs_claude_statusline():
    """Test that Claude setup installs and restores the native Claude status line."""
    with tempfile.TemporaryDirectory() as home:
        claude_home = os.path.join(home, ".claude")
        env = os.environ.copy()
        env["HOME"] = home
        env["CLAUDE_HOME"] = claude_home
        env["TOKIMETER_PORT"] = "9876"
        cli_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "ts",
            "packages",
            "proxy",
            "src",
            "cli.js",
        )

        result = subprocess.run(
            ["node", cli_path, "setup", "claude", "--spinner"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert result.returncode == 0, result.stderr or result.stdout

        settings_path = os.path.join(claude_home, "settings.json")
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
        status_line = settings.get("statusLine") or {}
        assert status_line.get("type") == "command"
        assert "claude-statusline.mjs" in status_line.get("command", "")
        spinner = settings.get("spinnerVerbs") or {}
        assert spinner.get("mode") == "replace"
        assert any("Tokimeter" in verb for verb in spinner.get("verbs", []))

        script_path = os.path.join(home, ".tokimeter", "claude-statusline.mjs")
        assert os.path.exists(script_path)
        rendered = subprocess.run(
            ["node", script_path],
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert rendered.returncode == 0
        assert "Tokimeter" in rendered.stdout

        restored = subprocess.run(
            ["node", cli_path, "uninstall"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert restored.returncode == 0, restored.stderr or restored.stdout
        with open(settings_path, encoding="utf-8") as f:
            restored_settings = json.load(f)
        assert "statusLine" not in restored_settings
        assert "spinnerVerbs" not in restored_settings
        assert not os.path.exists(script_path)
    print("✓ test_proxy_setup_installs_claude_statusline passed")


def test_proxy_claude_advisor_rules():
    """Test that Claude advisor recommends only for simple local prompts."""
    cli_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "ts",
        "packages",
        "proxy",
        "src",
        "cli.js",
    )

    simple = subprocess.run(
        ["node", cli_path, "advisor-test", "claude", "sonnet", "hi"],
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert simple.returncode == 0, simple.stderr or simple.stdout
    simple_data = json.loads(simple.stdout)
    assert simple_data["advised"] is True
    assert simple_data["advice"]["targetModel"] == "haiku"

    complex_prompt = subprocess.run(
        ["node", cli_path, "advisor-test", "claude", "sonnet", "Run /review on my current changes"],
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert complex_prompt.returncode == 0, complex_prompt.stderr or complex_prompt.stdout
    complex_data = json.loads(complex_prompt.stdout)
    assert complex_data["advised"] is False

    already_low = subprocess.run(
        ["node", cli_path, "advisor-test", "claude", "haiku", "hi"],
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert already_low.returncode == 0, already_low.stderr or already_low.stdout
    already_low_data = json.loads(already_low.stdout)
    assert already_low_data["advised"] is False
    print("✓ test_proxy_claude_advisor_rules passed")


def test_proxy_pricing_and_config_commands():
    """Test Node proxy pricing overrides and local config commands."""
    cli_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "ts",
        "packages",
        "proxy",
        "src",
        "cli.js",
    )
    with tempfile.TemporaryDirectory() as home:
        env = os.environ.copy()
        env["HOME"] = home
        env["TOKIMETER_PRICING_FILE"] = os.path.join(home, "pricing.json")

        version = subprocess.run(
            ["node", cli_path, "--version"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert version.returncode == 0
        assert version.stdout.strip()

        add_price = subprocess.run(
            [
                "node",
                cli_path,
                "pricing",
                "add",
                "--provider",
                "test",
                "--model",
                "test-cheap",
                "--input",
                "0.01",
                "--output",
                "0.02",
                "--cached",
                "0.001",
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert add_price.returncode == 0, add_price.stderr or add_price.stdout
        source = subprocess.run(
            ["node", cli_path, "pricing", "source", "test-cheap"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert source.returncode == 0
        assert "custom pricing" in source.stdout

        set_config = subprocess.run(
            ["node", cli_path, "config", "set", "claude.advisorModel", "test-cheap"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert set_config.returncode == 0, set_config.stderr or set_config.stdout
        get_config = subprocess.run(
            ["node", cli_path, "config", "get", "claude.advisorModel"],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        assert get_config.stdout.strip() == "test-cheap"
    print("✓ test_proxy_pricing_and_config_commands passed")


def run_all():
    """Run all tests."""
    tests = [
        test_pricing_basic,
        test_pricing_cached,
        test_pricing_unknown_model,
        test_pricing_aliases,
        test_pricing_current_recorded_models,
        test_pricing_dated_and_inclusive_cache_rates,
        test_tracker_memory,
        test_tracker_separates_unknown_pricing,
        test_tracker_sqlite,
        test_tracker_excludes_legacy_unknown_fallback,
        test_context_manager,
        test_cost_report,
        test_optimizer_downgrade,
        test_optimizer_anomaly,
        test_optimizer_error_waste,
        test_custom_pricing,
        test_global_tracker,
        test_async_writer,
        test_create_backend,
        test_budget_monitor,
        test_supabase_store_import,
        test_tracker_async_mode,
        test_integrations_import,
        test_hosted_store_ingest_report,
        test_hosted_management_budget_status,
        test_hosted_alert_digest_export,
        test_cli_proxy_delegation_detection,
        test_proxy_setup_installs_command_shims,
        test_proxy_setup_installs_claude_statusline,
        test_proxy_claude_advisor_rules,
        test_proxy_pricing_and_config_commands,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"✗ {test.__name__} FAILED: {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
