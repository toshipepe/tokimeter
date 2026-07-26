# Tokimeter — AI Cost Tracker for VS Code

See what Claude Code and Codex CLI actually cost you, without leaving the
editor. Tokimeter reads usage that already exists on your machine and shows
totals, per-model breakdowns, and budget warnings in a dashboard and the
status bar.

This extension is a viewer and control surface for the local
[Tokimeter](https://github.com/toshipepe/tokimeter) proxy at
`http://localhost:8788`. It does not intercept VS Code Copilot, Cursor
built-in AI, or closed desktop traffic by itself.

## Features

- **Status bar** — today's spend and the latest model used, at a glance.
- **Cost dashboard** — All / Claude / Codex filters, today's totals, and
  by-tool / by-model / by-project breakdowns. `~$X` marks API-equivalent
  estimates (what subscription usage *would* cost on the API); billed proxy
  usage shows plain `$X`. Estimates are never presented as bills.
- **One-click actions** — run local setup, readiness check, start/stop the
  proxy, open a watch terminal, import Codex rollouts or Claude transcripts.
- **Local tips** — optional rotating cost tips while AI tools are thinking.
  No extra model calls, ever.
- **Budget warning** — optional `tokimeter.dailyBudget`, evaluated locally.

## Privacy

Tokimeter tracks **usage metadata only**: tokens, models, costs, timestamps,
and project paths. Prompts and code are never read, stored, or displayed. See
the project's [SECURITY.md](https://github.com/toshipepe/tokimeter/blob/main/SECURITY.md).

## First run

Install and configure the local proxy first:

```bash
npm install -g tokimeter
tokimeter setup --auto
```

Then run **Tokimeter: Show Cost Dashboard** from the Command Palette. If the
status bar shows "offline", run **Tokimeter: Run Local Setup** or
`tokimeter repair` in a terminal.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tokimeter.proxyUrl` | `http://localhost:8788` | Where the local proxy listens |
| `tokimeter.showStatusBar` | `true` | Show today's cost in the status bar |
| `tokimeter.showTipsDuringWait` | `true` | Rotating local tips while AI tools think |
| `tokimeter.tipInterval` | `5000` | Tip rotation interval (ms) |
| `tokimeter.dailyBudget` | `0` | Daily budget in dollars for local warnings (0 = off) |

## Developing / smoke-testing this extension

From a checkout of the Tokimeter repo:

1. `cd ts/packages/vscode-extension`
2. `npm install` (installs `@types/vscode` only; the extension is plain JS
   with no compile step)
3. Open the folder in VS Code and press **F5** ("Run Extension"). A new
   Extension Development Host window opens with the extension loaded.
4. In the dev host, check:
   - the **status bar item** appears (or shows offline if the proxy is down),
   - **Tokimeter: Show Cost Dashboard** opens the webview and the All /
     Claude / Codex filters switch the numbers,
   - **Tokimeter: Run Local Setup** and **Tokimeter: Open Watch Terminal**
     spawn terminals,
   - with the proxy stopped, the dashboard shows its offline hint instead of
     erroring.
5. Package with `npm run pack:vscode` from the `ts/` workspace root (or
   `npm run package` here). Install the generated `tokimeter-vscode.vsix` via
   "Extensions: Install from VSIX…" for a final end-to-end check.
