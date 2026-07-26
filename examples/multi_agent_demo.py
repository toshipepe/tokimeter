"""
Example: Using Tokimeter to track a multi-agent system.

This example simulates a realistic multi-agent setup:
  - A customer support triage agent using GPT-4o
  - A content generator using Gemini Flash
  - A code reviewer using Claude Sonnet

It shows manual tracking, context managers, and the optimizer.

Run: python examples/multi_agent_demo.py
"""

import sys
import os
import random

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tokimeter import Tracker, Optimizer
from tokimeter.pricing import Pricer


def main():
    # Create a persistent tracker
    db_path = "tokimeter_demo.db"

    # Clean up old demo
    if os.path.exists(db_path):
        os.unlink(db_path)

    tracker = Tracker(db_path=db_path)
    print("🚀 Tokimeter — Multi-Agent Demo\n")

    # ─── Simulate agents ──────────────────────────────────────────────────

    agents = [
        {
            "name": "support-triage",
            "model": "gpt-4o",
            "provider": "openai",
            "calls": 50,
            "avg_input": 350,
            "avg_output": 120,
        },
        {
            "name": "content-generator",
            "model": "gemini-2.5-flash",
            "provider": "google",
            "calls": 80,
            "avg_input": 200,
            "avg_output": 800,
        },
        {
            "name": "code-reviewer",
            "model": "claude-sonnet-4",
            "provider": "anthropic",
            "calls": 25,
            "avg_input": 2000,
            "avg_output": 600,
        },
        {
            "name": "doc-summarizer",
            "model": "claude-opus-4",  # Expensive! Will trigger downgrade rec.
            "provider": "anthropic",
            "calls": 30,
            "avg_input": 3000,
            "avg_output": 500,
        },
    ]

    print(f"Simulating {sum(a['calls'] for a in agents)} calls across {len(agents)} agents...\n")

    for agent in agents:
        with tracker.track(agent_name=agent["name"], workflow="production", customer="acme-corp"):
            for i in range(agent["calls"]):
                tracker.record(
                    provider=agent["provider"],
                    model=agent["model"],
                    input_tokens=int(agent["avg_input"] * random.uniform(0.6, 1.5)),
                    output_tokens=int(agent["avg_output"] * random.uniform(0.5, 1.4)),
                    latency_ms=random.uniform(200, 2500),
                )

    # ─── Show report ───────────────────────────────────────────────────────

    report = tracker.get_report()
    print(f"{'='*60}")
    print(f"  COST REPORT")
    print(f"{'='*60}")
    print(f"  Total Cost:    ${report.total_cost:.4f}")
    print(f"  Total Calls:   {report.total_calls}")
    print(f"  Input Tokens:  {report.total_input_tokens:,}")
    print(f"  Output Tokens: {report.total_output_tokens:,}")
    print(f"  Avg Cost/Call: ${report.total_cost / report.total_calls:.6f}")
    print()

    print(f"  {'Agent':<24} {'Model':<24} {'Cost':>10} {'Share':>8}")
    print(f"  {'-'*24} {'-'*24} {'-'*10} {'-'*8}")
    for agent, cost in sorted(report.by_agent.items(), key=lambda x: -x[1]):
        model_for_agent = [a["model"] for a in agents if a["name"] == agent][0]
        pct = cost / report.total_cost * 100
        print(f"  {agent:<24} {model_for_agent:<24} ${cost:>9.4f} {pct:>7.1f}%")

    # ─── Show recommendations ──────────────────────────────────────────────

    print(f"\n{'='*60}")
    print(f"  OPTIMIZATION RECOMMENDATIONS")
    print(f"{'='*60}")

    calls = tracker.get_calls()
    optimizer = Optimizer()
    recs = optimizer.analyze(calls)

    if not recs:
        print("  ✓ No optimization opportunities found.")
    else:
        total_savings = sum(r.estimated_savings_monthly for r in recs)
        print(f"  Potential savings: ${total_savings:.2f}/mo\n")

        for rec in recs:
            print(f"  [{rec.severity.upper()}] {rec.title}")
            print(f"  → {rec.description}")
            print(f"  Action: {rec.action}")
            print()

    print(f"\n  Database saved to: {db_path}")
    print(f"  Run 'tokimeter dashboard --db {db_path}' for the web dashboard.")


if __name__ == "__main__":
    main()
