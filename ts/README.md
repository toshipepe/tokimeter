# <img src="../favicon.svg" width="26" alt=""> Tokimeter — TypeScript Packages

**Real-time LLM cost tracking for AI coding tools.**

This directory contains the TypeScript/Node.js packages that make up the
Tokimeter real-time tracking system:

```
ts/packages/
├── core/              ← Shared pricing database + cost calculator + tip engine
├── proxy/             ← Local proxy server + CLI wrapper
└── vscode-extension/  ← VS Code extension with dashboard and tips
```

## Quick Start

### 1. Install the proxy wrapper

```bash
# Target install flow once published:
npm install -g @tokimeter/proxy

# Current private-repo install flow from the repo root:
npm install -g ./ts/packages/proxy
```

The global package installs three commands:

```bash
tokimeter        # proxy wrapper and setup CLI
tm               # short alias for tokimeter
tokimeter-proxy  # proxy server
```

Release dry-runs:

```bash
npm pack --workspace @tokimeter/core --dry-run
npm pack --workspace @tokimeter/proxy --dry-run
npm run package --workspace tokimeter
```

The VS Code package command writes
`ts/packages/vscode-extension/tokimeter-vscode.vsix` for local testing.

### 2. Or install automatic terminal shims

```bash
tokimeter setup codex --auto
tokimeter setup claude --auto

# Restart your terminal, then use your normal CLI commands:
codex exec "fix this bug"
claude "review this file"

# Remove generated shims later:
tokimeter uninstall
```

The shims live in `~/.tokimeter/bin` and call the Tokimeter wrapper before
handing off to the real Codex or Claude binary. Auto setup also installs
`tokimeter` and `tm` helper shims there, so `tokimeter watch` and `tm doctor`
work even before the npm package is published globally.

After setup, daily use is just your normal terminal workflow. Keep typing
`codex ...` and `claude ...`; the generated shims handle Tokimeter tracking.
For Codex ChatGPT-login mode, `codex exec ...` records an estimated event from
Codex's final token summary. Interactive bare `codex` needs a real terminal and
opens normally; Tokimeter monitors recent Codex rollout `token_count` metadata
while Codex is running and, when the optional PTY layer is available, draws a
small terminal overlay after turns finish. Without PTY support it falls back to
terminal-title updates and `~/.tokimeter/inline-events.jsonl`. Historical Codex
imports are opt-in with
`tokimeter codex-import --backfill`.

Use `tokimeter watch` as a diagnostic/status view for a quiet, token-safe change feed
with latest-call model/effort details and a compact daily model breakdown while
a CLI tool is working. It prints when usage changes; use
`tokimeter watch --live` for repeated polling output. Watch labels calls as
`exact`, `estimated`, `imported`, or `fallback pricing` so users can tell
proxied usage from local metadata and unknown-price estimates. `codex exec ...`
can also show a preflight savings hint before the run starts; that hint uses
local text rules only and never sends an extra model request.

In a source checkout, the Python `tokimeter` command delegates proxy-shaped
commands such as `tokimeter setup codex --auto` and `tokimeter doctor` to this
Node wrapper. `tm` is still useful as the explicit short alias after the proxy
package is installed globally.

### 3. Start the proxy manually

```bash
# From this directory:
node packages/proxy/src/server.js

# After global install:
tokimeter-proxy
```

### 4. Point your AI tools at the proxy manually

```bash
# For Claude Code CLI:
export ANTHROPIC_BASE_URL=http://localhost:8788

# For Codex CLI / OpenAI API-key mode:
export OPENAI_BASE_URL=http://localhost:8788

# Now use your tools normally:
claude "refactor this file"
codex "fix this bug"
```

Or use the `tm` wrapper directly (auto-starts proxy + sets env vars):

```bash
node packages/proxy/src/cli.js claude "refactor this file"
node packages/proxy/src/cli.js codex-chatgpt exec --skip-git-repo-check "say hello"

# After install:
tokimeter claude "refactor this file"
tm codex-chatgpt exec --skip-git-repo-check "say hello"
```

Codex API-key mode is tracked by proxying OpenAI API responses. Codex
ChatGPT/subscription `exec` mode is tracked by running Codex with your normal
login and recording the token summary Codex prints at the end of the run.

### 5. See real-time costs

The proxy prints costs to stderr after every call:

```
✓ 💰 $0.0435 | today: $0.63 (6 calls) | lifetime: $12.40
💡 10x gpt-4o → gpt-4o-mini: save ~$1.9/mo (95% quality match)
```

## How It Works

```
Claude Code / Codex API-key mode / Aider
        │
        ▼
┌──────────────────┐
│  Tokimeter     │     1. Intercepts the API call
│  Proxy :8788     │     2. Forwards to real API (api.anthropic.com / api.openai.com)
│                  │     3. Reads token usage from response
│  (Node.js)       │     4. Calculates cost using pricing database
│                  │     5. Logs to ~/.tokimeter/calls.jsonl
└────────┬─────────┘     6. Prints cost + tip to stderr
         │
         ▼
┌──────────────────┐
│  VS Code         │     Polls proxy every 5 seconds
│  Extension       │     Shows status bar, tips, dashboard
└──────────────────┘
```

For Codex ChatGPT/subscription mode, the wrapper posts a local summary event to
the same proxy API after Codex exits, so the extension and dashboard still read
one unified stream.

## VS Code Extension

### Install (development)

1. Open `ts/packages/vscode-extension/` in VS Code
2. Press `F5` to launch an Extension Development Host
3. In the new window, open the Command Palette and run:
   - `Tokimeter: Show Cost Dashboard`

### Features

- **Status bar** — Shows today's spend and call count
- **Real-time tips** — Rotating cost optimization suggestions during AI thinking states
- **Dashboard** — Webview with KPIs, estimated savings, model breakdown, recent calls, recommendations, setup/watch controls
- **Wait state detection** — Best-effort terminal activity hints for Claude Code/Codex spinner patterns when VS Code exposes terminal data events
- **Proxy health** — Warns you if the proxy isn't running
- **Local controls** — Command palette actions for setup, watch, latest call, tips, and tip toggling

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `tokimeter.proxyUrl` | `http://localhost:8788` | Proxy server URL |
| `tokimeter.showStatusBar` | `true` | Show cost in status bar |
| `tokimeter.showTipsDuringWait` | `true` | Show tips during AI thinking |
| `tokimeter.dailyBudget` | `0` | Optional daily budget in dollars for VS Code warnings |
| `tokimeter.tipInterval` | `5000` | Tip rotation interval (ms) |

## CLI Wrapper (`tokimeter` / `tm`)

The `tokimeter` command wraps any AI CLI tool with automatic cost tracking.
`tm` is the shorter alias:

```bash
tokimeter claude "refactor auth.py"     # Claude Code
tokimeter codex "fix the bug"           # Codex CLI
tm aider --message "add tests"          # Aider
tm cursor "explain this"                # Cursor CLI

tokimeter start   # Start proxy in foreground
tokimeter stop    # Stop background proxy
tm status         # Show proxy status and costs
tm watch          # Quiet local spend/model change feed
tm watch --live   # Reprint the local view every few seconds
tm watch --debug  # Include Codex metadata import diagnostics
tm codex-import   # Import recent Codex rollout token metadata
tm pricing source claude-sonnet-4       # Explain pricing source/confidence
tm config set claude.advisorModel haiku # Set Claude advisor target
```

The wrapper:
1. Checks if the proxy is running (starts it if not)
2. Sets the correct `BASE_URL` environment variable
3. Runs the real CLI tool with all args passed through
4. Prints a session cost summary when the tool exits

## Architecture

### `@tokimeter/core`

Shared library used by both the proxy and the extension:
- `pricing.js` — 45+ model pricing database (OpenAI, Anthropic, Google, Mistral, xAI, etc.)
- `tracker.js` — In-memory call tracker with summaries and tip generation

### `@tokimeter/proxy`

Local HTTP proxy that intercepts LLM API calls:
- `server.js` — The proxy server (Node.js built-ins only)
- `cli.js` — The `tokimeter` / `tm` CLI wrapper

The proxy auto-detects the provider from the request path:
- `/v1/messages` → Anthropic (Claude Code)
- `/v1/chat/completions` → OpenAI (Codex, Cursor)
- `/v1/responses` → OpenAI Responses API

It reads token usage from the response body (supporting all three provider formats) and calculates cost using the shared pricing database.

### `vscode-extension`

VS Code extension that polls the proxy and displays cost intelligence:
- Status bar with live cost counter
- Dashboard webview with charts and recommendations
- Terminal monitoring for AI tool "thinking" states
- Output channel with per-call cost lines

## Data Storage

Call data is stored in `~/.tokimeter/calls.jsonl` (one JSON object per line).
This is append-only and can be analyzed with `jq`, Python, or any JSON parser.

```bash
# See today's costs:
cat ~/.tokimeter/calls.jsonl | jq 'select(.timestamp > (now - 86400) * 1000) | .totalCost' | paste -sd+ - | bc

# Find your most expensive calls:
cat ~/.tokimeter/calls.jsonl | jq -s 'sort_by(-.totalCost) | .[0:5] | .[] | {model, totalCost, timestamp}'
```

## Dependencies

The proxy server uses only Node.js built-in modules:
- `http`, `https` — Proxy server and API calls
- `fs` — Data persistence
- `child_process` — CLI wrapper
- `path`, `os`, `url` — Utilities

The proxy package also declares optional `node-pty` support for the interactive
Codex terminal overlay. If `node-pty` is unavailable, Tokimeter falls back to
normal Codex execution plus terminal-title/log updates.
