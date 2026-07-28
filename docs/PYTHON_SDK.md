# Tokimeter Python SDK

Drop-in usage tracking for Python apps you control. For terminal AI tools (Claude Code, Codex), use the CLI — see the [main README](../README.md).

## Two-Minute Integration

### Option A: Auto-Instrument Your SDK (Zero Code Changes)

```python
from tokimeter import Tracker

tracker = Tracker("finops.db")  # SQLite, or use Supabase for teams

# Patch your LLM SDKs — all calls are now tracked automatically
tracker.instrument_openai()
tracker.instrument_anthropic()
tracker.instrument_google()

# Just use your SDKs normally
import openai
response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
# → Automatically tracked with cost, tokens, latency
```

### Option B: Framework Integration (LangChain, CrewAI, LiteLLM)

```python
from tokimeter import Tracker
from tokimeter.integrations import instrument_langchain, instrument_crewai

tracker = Tracker("finops.db")
instrument_langchain(tracker)  # patches ChatOpenAI, ChatAnthropic, ChatGoogle
instrument_crewai(tracker)     # wraps CrewAI agents for per-agent attribution

# Use your framework normally — everything is tracked
```

### Option C: Context Manager (Manual Attribution)

```python
from tokimeter import Tracker, track

tracker = Tracker("finops.db")

with track("customer-support", workflow="triage", customer="acme"):
    response = openai.chat.completions.create(...)
    # This call is attributed to: agent=support, workflow=triage, customer=acme
```

## Storage Backends

### SQLite (Solo Devs & Development)

Zero config. Just pass a file path:

```python
tracker = Tracker("finops.db")
```

### Supabase / Postgres (Teams & Production)

Free hosted Postgres with real-time capabilities.

**Setup:**

1. Create a free project at [supabase.com](https://supabase.com)
2. Run `supabase_schema.sql` in Dashboard → SQL Editor
3. Set environment variables:

```bash
export TOKIMETER_SUPABASE_URL=https://yourproject.supabase.co
export TOKIMETER_SUPABASE_KEY=your-anon-key
```

4. Create a tracker — it auto-detects Supabase:

```python
tracker = Tracker()  # auto-detects env vars, uses Supabase
```

Or use the interactive setup wizard:

```bash
tokimeter setup
```

### Async Mode (Production — Non-Blocking)

For production, enable async batched writes so tracking never slows down your app:

```python
tracker = Tracker(
    db_path="finops.db",     # or Supabase via env vars
    use_async=True,           # non-blocking batched writes
)
# Calls are buffered in a background thread and flushed every 2 seconds
```

## Cost Optimization Recommendations

The optimizer analyzes your call history and finds actionable savings:

```python
from tokimeter import Optimizer

optimizer = Optimizer()
recs = optimizer.analyze(tracker.get_calls())

for rec in recs:
    print(f"[{rec.severity}] {rec.title}")
    print(f"  Save ${rec.estimated_savings_monthly:.2f}/mo")
    print(f"  {rec.action}")
```

**Five types of waste it detects:**

| Type | What It Finds | Example |
|------|---------------|---------|
| **Model Downgrade** | Expensive models used for simple tasks | "GPT-4o for triage → GPT-4o-mini, save 94%" |
| **Cache Opportunity** | Repeated prompts not using caching | "50% of input tokens are cacheable" |
| **Anomaly Detection** | Outlier calls costing >3x average | "1 call cost 10x normal — check context window" |
| **Repeated Calls** | Identical calls that could be cached | "200 identical calls — add response cache" |
| **Error Waste** | Failed calls that still cost money | "13 rate-limit errors — add retries" |

## Budget Alerts

Get notified before you overspend:

```python
from tokimeter import Tracker
from tokimeter.alerts import BudgetMonitor, Budget, SlackNotifier, DiscordNotifier

tracker = Tracker("finops.db")

budgets = [
    Budget(name="Daily Cap", limit=10.0, period="daily"),
    Budget(name="Support Agent Monthly", limit=200.0, period="monthly",
           agent_name="support-bot", alert_at_pct=80),
]

monitor = BudgetMonitor(
    tracker=tracker,
    budgets=budgets,
    notifiers=[
        SlackNotifier(webhook_url="https://hooks.slack.com/services/..."),
        DiscordNotifier(webhook_url="https://discord.com/api/webhooks/..."),
    ],
)

# Run as background thread (checks every 5 minutes)
monitor.start()
```

Supports: **Slack**, **Discord**, **Email (SMTP)**, and **generic webhooks** (Teams, Zapier, n8n, etc.)

## Web Dashboard

```bash
tokimeter dashboard --db finops.db --port 8747
```

Dark-themed, real-time dashboard with:
- KPI cards (total spend, input/output costs, potential savings)
- Spend by agent, model, and provider (with bar charts)
- Daily spend trend
- Optimization recommendations with savings estimates
- Recent calls log
- Auto-refreshes every 5 seconds
- Works with both SQLite and Supabase backends

## CLI Commands

```bash
tokimeter demo                     # Generate demo data + show report
tokimeter report                   # Show cost report from DB
tokimeter report --db finops.db    # DB path can go before or after subcommand
tokimeter report --days 7          # Last 7 days only
tokimeter recs                     # Show optimization recommendations
tokimeter models                   # List all known model pricing (45+)
tokimeter models --provider google # Filter by provider
tokimeter dashboard                # Launch web dashboard
tokimeter setup                    # Interactive setup wizard (SQLite/Supabase)
tokimeter budgets                  # Check budget status
tokimeter watch                    # Quiet local spend/model change feed
tokimeter watch --once             # Show local proxy spend + current savings tip
tokimeter watch --live             # Reprint the local view every few seconds
tokimeter watch --debug            # Include Codex metadata import diagnostics
tokimeter pricing list             # List built-in/custom JS proxy pricing
tokimeter pricing source <model>   # Explain built-in/custom/unpriced pricing
tokimeter pricing add ...          # Add local pricing override for new models
tokimeter config list              # Show local proxy/advisor settings
tokimeter codex-import             # Import recent Codex rollout token metadata
tokimeter codex-import --backfill  # Intentionally import older Codex sessions
tokimeter hosted init              # Create local hosted org/project/API key
tokimeter hosted serve             # Run local hosted ingestion API
```

Unknown Python SDK models are unpriced: their heuristic is kept in
`rough_estimate_cost` report metadata and excluded from `total_cost`.

## Hosted SaaS Scaffold

The hosted version is now scaffolded locally. It is not a finished SaaS yet,
but it has the core contract: orgs, users, projects, hashed API keys, event
ingestion, reports, recommendations, budgets, API-key management, and a local
hosted dashboard. Pro scaffolding now includes budget alert events, alert
channels, weekly digest data, and CSV export.

```bash
tokimeter hosted --db tokimeter_hosted.db init \
  --org "Acme" \
  --email "owner@example.com" \
  --project "production"

tokimeter hosted --db tokimeter_hosted.db serve --port 8789
```

Then open `http://127.0.0.1:8789/` and paste the API key created by `init`.

Hosted API endpoints include:

- `GET /v1/me`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/api-keys`
- `POST /v1/api-keys`
- `POST /v1/api-keys/revoke`
- `GET /v1/calls`
- `GET /v1/reports`
- `GET /v1/recommendations`
- `GET /v1/budgets`
- `POST /v1/budgets`
- `GET /v1/budget-status`
- `GET /v1/alert-channels`
- `POST /v1/alert-channels`
- `GET /v1/alerts`
- `POST /v1/alerts/evaluate`
- `GET /v1/digest`
- `GET /v1/export/calls.csv`

Local proxy calls can sync to this hosted API:

```bash
export TOKIMETER_CLOUD_URL=http://127.0.0.1:8789
export TOKIMETER_API_KEY=tmk_live_...
```

If hosted sync fails, the proxy writes pending events to
`~/.tokimeter/cloud-pending.jsonl` and retries in the background.

Use `hosted_schema.sql` for the production-oriented Supabase/Postgres schema.
Use `docs/IMPLEMENTATION_STATUS.md` and `docs/PRODUCTION_PLAN.md` as the
current handoff for what works and what still needs to ship.

## Supported Providers (45+ models)

| Provider | Models |
|----------|--------|
| **OpenAI** | GPT-4o, 4o-mini, 4.1, 4.1-mini, 4.1-nano, o1, o1-mini, o3, o3-mini, o4-mini |
| **Anthropic** | Claude Opus 4, Sonnet 4, Haiku 4, 3.5 Sonnet/Haiku, 3 Opus/Haiku |
| **Google** | Gemini 3 Pro/Flash/Flash-Lite, 2.5 Pro/Flash, 1.5 Pro/Flash/8B |
| **Mistral** | Large, Medium, Small, Codestral |
| **Meta Llama** | Llama 4 Scout/Maverick, 3.3 70B, 3.1 405B/70B/8B |
| **xAI** | Grok 4, 4 Fast, 3, 3 Mini, 2 |
| **DeepSeek** | V3, R1, Coder |
| **Cohere** | Command R+, R, R7B |
| **Z.AI** | GLM-5 Plus/Air/Flash, GLM-4 Plus/Air/Flash |

## Framework Integrations

| Framework | Function | What It Does |
|-----------|----------|-------------|
| **LangChain** | `instrument_langchain(tracker)` | Patches ChatOpenAI, ChatAnthropic, ChatGoogle |
| **CrewAI** | `instrument_crewai(tracker)` | Wraps each agent's execution with attribution |
| **LiteLLM** | `instrument_litellm(tracker)` | Patches litellm.completion() for any provider |
| **Any** | `@track_agent_run(tracker, "name")` | Decorator for any function |
