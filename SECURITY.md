# Security & Privacy

Tokimeter is local-first. This page explains exactly what it can see, where data
lives, and what never leaves your machine.

## What Tokimeter reads

| Source | What is read | Mode |
|---|---|---|
| `~/.claude/projects/*.jsonl` | Token usage metadata from Claude Code transcripts: token counts, model names, timestamps, session ids, project paths (`cwd`) | Read-only |
| `~/.codex/sessions/*.jsonl` | Codex rollout `token_count` events: token counts, model, effort, `cwd` | Read-only |
| Proxy traffic (opt-in) | If you enable the local proxy for API-key usage, requests to provider APIs pass through `localhost` so usage headers/bodies can be metered | Localhost only |

`tokimeter report` and `tokimeter limits` use only the read-only paths — no
proxy, no shims, no writes outside `~/.tokimeter`.

## What Tokimeter stores

- All data lives in `~/.tokimeter/` on your machine: tracked call metadata
  (tokens, models, costs, project paths, session ids), settings, and a cached
  model-pricing table.
- **Prompt and response content is never stored.** The tracker records usage
  *metadata* only. Transcript files are parsed for their `usage` fields; the
  message text is not persisted by Tokimeter.

## What Tokimeter sends over the network

- **Nothing, by default.** No telemetry, no analytics, no phone-home.
- `tokimeter pricing refresh` (manual command) fetches a public model-price
  table over HTTPS and caches it locally.
- The optional proxy forwards your API traffic directly to the provider you
  configured (`api.openai.com`, `api.anthropic.com`, ...). It binds to
  `localhost` only and adds no third-party hops.
- Cloud sync exists only if you explicitly set `TOKIMETER_CLOUD_URL` and
  `TOKIMETER_API_KEY`. Even then, only usage metadata is synced — never prompt
  or response content.

## API keys

- Tokimeter never logs, stores, or transmits your API keys. The proxy passes
  your `Authorization`/`x-api-key` headers through to the provider unchanged.
- Subscription-mode tracking (Claude Pro/Max, ChatGPT/Codex) involves no keys
  at all — it reads local files the vendor tools already write.

## Uninstall / footprint

- `tokimeter uninstall` removes generated shims and restores your Claude
  status-line configuration.
- `rm -rf ~/.tokimeter` removes all stored data.
- Shims are plain shell scripts in `~/.tokimeter/bin` that `exec` the real
  tool — inspect them with `cat`.

## Reporting a vulnerability

Report security issues privately through
[Tokimeter support](https://tokimeter.com/support/?topic=security). Do not open
a public issue containing vulnerability details. Please include reproduction
steps. We aim to respond within 72 hours.
