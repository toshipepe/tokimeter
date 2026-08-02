# Changelog

All notable changes to the `tokimeter` CLI. Dates are UTC.
The versioning is [semver](https://semver.org); pre-1.0, minor versions may add features freely.

## Unreleased

## 0.5.8 — 2026-08-03

### Fixed

- Classify Codex vendor-reported rate-limit windows by their recorded duration
  instead of assuming the primary slot is five hours and the secondary slot is
  weekly.
- Label a weekly-only primary window correctly, order reversed five-hour and
  weekly slots consistently, and display unfamiliar durations literally
  without inventing quota semantics.
- Preserve the same duration classification when syncing supported Codex limit
  snapshots to the optional hosted dashboard.

## 0.5.7 — 2026-08-02

### Added

- Add `npx tokimeter install` as the single public command for installing the
  stable global runtime, configuring supported local integrations, and
  verifying setup.
- Add `npx tokimeter install --dry-run` to preview the package and setup actions
  without changing packages, files, processes, or settings.
- Pin installation to the same package version already running through `npx`,
  then invoke setup from npm's resolved global package directory instead of
  relying on a newly refreshed shell `PATH`.

### Safety

- Keep installation explicit; the npm package still has no `install` or
  `postinstall` lifecycle hook.
- Stop before setup when the global package installation fails and provide a
  direct recovery command when global resolution or setup cannot finish.

## 0.5.6 — 2026-08-02

### Fixed

- Make generated Tokimeter, `tm`, Codex, and Claude launchers follow the
  currently active global Tokimeter installation instead of pinning the Node
  version that was active during setup.
- Detect legacy Node-version-pinned launchers in `tokimeter doctor` and show an
  actionable repair message instead of a `MODULE_NOT_FOUND` stack trace when
  an old Node installation has been removed.

### Pricing

- Add Anthropic's published Claude Opus 5 API price.
- Recognize `codex-auto-review` as an internal, intentionally unpriced model
  identifier rather than applying an unsupported public-model price.

## 0.5.5 — 2026-07-31

### Fixed

- Resume a reconnected hosted dashboard from the last successful local sync
  instead of restarting the complete first-connection backfill.
- Send recent metadata first during a large manual replay so the dashboard
  catches up with current activity before older history.
- Honor the hosted ingest retry delay during an interactive sync and resume the
  same batch automatically across bounded quota windows.

## 0.5.4 — 2026-07-28

### Trust and pricing

- Separate verified built-in, community-feed, custom, reported, and
  fallback/unpriced price sources throughout local summaries and reports.
- Exclude unknown-model fallback estimates from authoritative priced totals and
  show them separately as rough estimates in both the Node CLI and Python SDK.
- Add compact public pricing methodology and npm release documentation.

### Setup and release safety

- Add `tokimeter setup --dry-run`, print setup plans before mutation, and restore
  prior Codex and Claude configuration during uninstall where supported.
- Add a manual, tag-gated, SHA-pinned npm staged-publishing workflow. It stages a
  package for later owner approval and never performs a live `npm publish`.
- Document that Tokimeter packages have no install or postinstall scripts.

## 0.5.1 — 2026-07-17

### Fixed
- **Current Hermes session databases** — Tokimeter now inspects the installed
  `~/.hermes/state.db` schema before reading sessions. New Hermes releases that
  omit the older `cwd` and Git attribution columns retain exact token, model,
  billing-provider, and xAI OAuth tracking instead of returning zero usage.
  Older schemas remain supported through safe defaults for missing optional
  columns.
- **Hermes diagnostics** — `tokimeter doctor` reports whether recent Hermes
  sessions are recognized whenever a local Hermes database exists.
- **macOS global npm PATH recovery** — install docs now include a direct
  `$(npm prefix -g)/bin/tokimeter` bootstrap when zsh cannot find a successful
  global installation.

### Verification
- 95 Node tests pass, including current and legacy Hermes schema regressions.
- A current-schema SQLite smoke test reads a Grok 4.3 xAI OAuth session with
  exact input, output, and cache tokens.

## 0.5.0 — 2026-07-16

### Added
- **One-time hosted dashboard connection** — the signed-in dashboard creates a
  short-lived `tokimeter connect tmc_...` command. The CLI exchanges it for a
  revocable device key, stores that key locally with private file permissions,
  backfills 30 days, and enables automatic background sync.
- **All-reader cloud sync** — Cursor, Cline, Codex, Claude, Grok Build, Hermes,
  opencode, Copilot, Aider, and proxy-tracked API usage share one batched,
  idempotent metadata sync path. `tokimeter sync --days=N` can backfill on
  demand.
- **Cloud project privacy controls** — only the final project folder name is
  sent by default. `cloud.projectMode` can be set to `off`, `basename`, or the
  explicit opt-in `full` mode. Session identifiers are hashed before sync.
- **Bounded offline delivery** — hosted sync now uses contract version 1,
  atomic queue writes, exponential retry with jitter, capped flush work, and
  hard event/byte limits so a long outage cannot grow the local queue without
  bound. Health and doctor output show queued and dropped event counts.

### Security
- Prompts, responses, code, account identity, raw session IDs, and full paths
  are excluded from the default cloud payload and covered by regression tests.
- Device API keys are shown only once, stored hashed server-side, and can be
  revoked independently from the dashboard. Config listings redact stored
  credentials.

## 0.4.2 — 2026-07-13

### Fixed
- **Cline CLI 3.x live usage** — reads the new
  `~/.cline/data/sessions/*.messages.json` format, including model, provider,
  exact token buckets, and Cline-reported cost. Codex subscription sessions are
  attributed to tool `cline`, provider `OpenAI`, and access path
  `Codex OAuth (subscription)`. Message content and system prompts are ignored.

### Verification
- Live-verified local readers: Claude Code, Codex CLI, Cursor CLI/Desktop Agent,
  Grok Build, Hermes (including `api_server` sessions), opencode 1.17.18, and
  Cline CLI 3.0.39 using a Codex OAuth subscription.
- GitHub Copilot CLI remains fixture-tested because the live request was blocked
  by the tester's organization policy before any tokens were generated.
- Aider remains fixture-tested; live verification was intentionally skipped.
- API-key proxy routes remain test-covered but were not exercised against paid
  Anthropic/OpenAI APIs during release testing.

## 0.4.1 — 2026-07-13

### Added
- **Cross-tool provider rollups** — `tokimeter report --provider xai` combines
  xAI usage across direct Grok Build and Hermes while preserving the original
  tool attribution. Reports now include **By provider** and **By access path**;
  Hermes `xai-oauth` sessions are labeled `xAI OAuth (subscription)` without
  reading or storing account identity.
- **xAI subscription limits across access paths** — `tokimeter limits --tool
  grok` and the Grok 5-hour budget pulse include Hermes xAI OAuth sessions as
  well as direct Grok Build turns. Tokens are exact local totals; costs use a
  Hermes-reported actual cost when available, otherwise API-equivalent pricing.

### Fixed
- Cursor CLI capture for the July 2026 runtime: interactive stop hooks are
  detected again, Grok compatibility-hook forwards are ignored, and Cursor's
  `default` model is normalized to `cursor-auto`.
- Cursor's inline HUD no longer presents the just-finished turn as complete
  before its stop-hook record lands; duplicate stop events are deduplicated.
- Local report days and timestamps now consistently use the machine's local
  clock. Tokimeter does not store a location or timezone.

## 0.4.0 — 2026-07-12

### Added
- **Cursor CLI support** (`tokimeter setup cursor`) — Cursor's `stop`/`subagentStop`
  hooks pipe exact per-turn token usage (disjoint input/output/cache buckets);
  Tokimeter registers a capture hook that prices each turn and records the
  metadata locally, plus a Tokimeter status line rendered above the Cursor
  prompt (today/5h spend, `budget.cursor5h` warning, context-window use, model).
  Any pre-existing status line is preserved and re-rendered beneath ours;
  `tokimeter uninstall` restores everything. `--tool cursor` scopes reports.
  Capture starts at setup time; earlier turns are not recoverable.
- **Grok Build budget pulse** (`tokimeter setup grok`) — a self-contained Grok
  Stop hook raises one native desktop notification per threshold band
  (80% / 100% of `budget.grok5h`) when a turn ends, rate-limited, never nagging.
- **`tokimeter cursor-import <csv>`** — import a cursor.com dashboard usage
  export to cover desktop in-editor chat (which fires no hooks and writes no
  local usage). Handles all three export formats; Cursor's billed Cost column
  is kept as authoritative; re-imports are idempotent.
- **Richer Hermes attribution** — sessions now carry `git_repo_root` (used for
  project attribution), `git_branch`, session `title`, and `api_call_count`;
  older Hermes databases keep working via a query fallback.

## 0.3.0 — 2026-07-11 (tagged, not published to npm)

### Added
- **`tokimeter card`** — "My month in AI" shareable SVG card (1200×630, OG size)
  built from local token metadata: spend estimate, calls, tokens, active days,
  cache stats, and top tools/models. No projects, paths, or session ids on the
  card; nothing is uploaded — sharing is the user's action. Flags: `--month=YYYY-MM`,
  `--json`, `--stdout`, `--out=path`.
- **opencode support** — reads per-message usage from `~/.local/share/opencode`
  (both the message JSON files and the `opencode.db` database, opencode 1.2+;
  honors `OPENCODE_DATA_DIR`). `--tool opencode` scopes any report.
- **Cline support** — reads per-request usage from each task's local history
  across VS Code / VSCodium / Cursor / Windsurf globalStorage and the cline CLI
  data dir (`CLINE_TASKS_DIR` overrides). Only numeric usage fields are read;
  the request text Cline stores alongside them is never parsed. `--tool cline`.
- **GitHub Copilot CLI support** — reads the OpenTelemetry JSONL the CLI exports
  when `COPILOT_OTEL_FILE_EXPORTER_PATH` is set (default `~/.copilot/otel`),
  deduping overlapping span/log records. Without the exporter there is no local
  usage data to read. `--tool copilot`.

### Pricing
- Added **GPT-5.6 Sol / Terra / Luna** ($5/$30, $2.50/$15, $1/$6 per 1M, with
  explicit 1.25× cache-write rates), verified against the official pricing page.
- Added **Grok 4.5** ($2/$6 per 1M, 500k context), verified against docs.x.ai.
- Cheaper-tier mappings for the new models so `savings` can suggest downgrades.

## 0.2.3 — 2026-07

### Added
- `tokimeter plan` — headroom left in each budget window + time-to-limit at pace.
- `tokimeter agents` — director vs subagent cost split, by agent type and skill.
- `tokimeter report --orchestration` — cross-tool "used together" windows.

## 0.2.2 — 2026-07

### Added
- `tokimeter savings` (routine premium turns that could run cheaper, upper bound),
  `tokimeter burn` (runaway-agent alarm vs your own baseline), `tokimeter trace`,
  `tokimeter compare`, report export (`--json`/`--md`/`--html`), and
  `savings --emit-policy` (LiteLLM/OpenRouter routing policy from real usage).

## 0.2.1 and earlier

- Zero-setup `report`, `limits`, budgets, and the optional local proxy for full
  live tracking. Claude Code + Codex readers, Grok Build and Hermes support.
