# Tokimeter

**Local-first usage and cost meter for Claude Code, Codex, Cursor, Grok Build,
and other AI coding agents — no account, no telemetry.**

<p>
  <a href="https://www.npmjs.com/package/tokimeter"><img src="https://img.shields.io/npm/v/tokimeter.svg" alt="npm version" align="left" hspace="2"></a>
  <a href="https://github.com/toshipepe/tokimeter/releases/latest"><img src="https://img.shields.io/github/v/release/toshipepe/tokimeter" alt="GitHub release" align="left" hspace="2"></a>
  <a href="https://github.com/toshipepe/tokimeter/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" align="left" hspace="2"></a>
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-18+-green.svg" alt="Node 18+" align="left" hspace="2"></a>
</p>
<br clear="left">

[Website](https://tokimeter.com) ·
[Source](https://github.com/toshipepe/tokimeter)

## Try it now — no install

```bash
npx tokimeter report
```

Runs one private report from the usage metadata already on your machine.

## Install once — get the complete local meter

Reports, budgets, limit warnings, live status-line HUDs, and more:

```bash
npx tokimeter install
```

## Why Tokimeter exists

I use several coding agents, and each stores a different part of the usage
picture. Tokimeter brings the numeric metadata already on your machine into one
private report, so usage, limits, cache savings, and API-equivalent costs are
easier to understand.

Tokimeter reads usage metadata, not your prompts or responses. Local features
need no Tokimeter account, provider API key, proxy, telemetry, prompt upload, or
extra model call. Your data stays on your machine unless you explicitly connect
the optional hosted dashboard.

## What the local report shows

`npx` downloads Tokimeter into npm's temporary cache and runs one local report.
It does not permanently install the `tokimeter` command, start an ongoing local
meter, or enable optional dashboard syncing. It shows cost and tokens by tool,
provider, model, project, and day — including exact cache read/write accounting
and what prompt caching saved you. `--days=7`, `--tool cursor`,
`--provider xai`, and `--json` are supported.

The optional hosted dashboard starts with a 7-day Pro trial. If you do not
upgrade, cloud sync and hosted access pause at trial end; synced cloud data is
deleted 30 days later. Local reports and tracking remain free and continue on
your device.

Live-verified readers in this release: Claude Code CLI/Desktop, Codex
CLI/Desktop, Cursor CLI/Desktop Agent, Grok Build, Hermes, opencode 1.17.18,
and Cline CLI 3.0.39.
GitHub Copilot CLI and Aider are fixture-tested but were not completed as live
requests during release testing. Paid Anthropic/OpenAI API routes are
experimental and test-covered but were not exercised against paid APIs or
reconciled with provider invoices.

Claude Code and Codex coverage includes local coding sessions created from
their CLI and desktop surfaces. Regular Claude or ChatGPT chats and
remote/cloud-only sessions are outside the report when they do not write
supported usage records to this machine.

`--provider xai` combines direct Grok Build usage with xAI OAuth subscription
usage through Hermes while preserving each tool in **By tool**. No provider
account identity or credential is read or stored.

## Setup details

`npx tokimeter install` installs the same Tokimeter version globally, runs the
reviewable `setup --auto` flow, and verifies the result. It is an explicit CLI
command, not an automatic npm lifecycle script. Run
`npx tokimeter install --dry-run` to preview the install and setup without
changing anything. For an existing global installation,
`tokimeter setup --auto --dry-run` previews only the setup actions.
`tokimeter uninstall` restores prior supported-tool settings and removes
Tokimeter-generated setup files.

Close and reopen your terminal when setup finishes. Then keep using `codex`,
`claude`, and your other supported tools normally. Calling the executable by
its full npm location avoids the common macOS/zsh case where npm's global
executable directory is not yet on `PATH`; setup configures future terminals.

Generated launchers resolve the active global Tokimeter installation at run
time rather than saving a Node-version-specific package path. Switching Node
versions is therefore safe once Tokimeter is installed for the newly active
Node version. To migrate a launcher written by an older release after a
`MODULE_NOT_FOUND` error:

```bash
npx tokimeter install
```

## Limits: the 5-hour window

```bash
tokimeter limits
```

Subscription tools meter rolling windows and weekly caps. `limits` shows your
locally observed usage inside those windows, with warnings against budgets you
set. When Codex records its own rate-limit counters and reset times, Tokimeter
labels them **Vendor-reported**. It does not invent a vendor percentage or
reset time for tools that do not record one. The Grok view combines direct
Grok Build and Hermes xAI OAuth usage:

```bash
tokimeter config set budget.claude5h 60
tokimeter config set budget.grok5h 25
tokimeter config set budget.daily 50
```

## Ongoing local meter after setup

You get live per-call usage accounting, a Claude status-line HUD
(`today ~$48.16 · 5h ~$48.16 (80% ⚠)`), budgets, and:

```bash
tokimeter watch --tool claude    # live feed, per tool
tokimeter latest --tool codex    # most recent calls
tokimeter pricing refresh        # pull community price table (~280 models)
tokimeter doctor                 # optional troubleshooting
tokimeter uninstall              # restores prior configs; removes generated setup files
```

## Honest numbers

`~$X` marks API-equivalent estimates computed from exact local token counts —
on a subscription that's the value you're extracting, not a bill. Unknown
models are excluded from priced totals and shown only as a separate rough
fallback. Paid localhost-proxy accounting is experimental until reconciled
against provider invoices.
A budget percentage is measured against a threshold you configured; it is not
presented as a provider subscription allowance.

The package declares no `install` or `postinstall` lifecycle script.

MIT licensed. Source, security notes, and issue tracker:
https://github.com/toshipepe/tokimeter
