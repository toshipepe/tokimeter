# Security & Privacy

Tokimeter is local-first. This page explains exactly what it can see, where data
lives, and what never leaves your machine.

## What Tokimeter reads

| Surface | Files/data read | Files/data written | Optional Pro sync | Never synced |
|---|---|---|---|---|
| Zero-setup readers | Usage fields in `~/.claude/projects/*.jsonl`, `~/.codex/sessions/*.jsonl`, `~/.grok/logs/`, `~/.hermes/state.db`, opencode/Cline local histories, Cursor capture/CSV records, an enabled Copilot OTel export, or an explicitly selected Aider history | Nothing outside `~/.tokimeter`; a report printed to stdout writes only where the user redirects it | Token buckets, model/provider/tool, timestamp, numeric cost, latency/success, confidence/effort, hashed session id, and the privacy-selected project label | Prompts, responses, code, diffs, commands, repository contents, raw session ids, full paths by default, account/provider credentials |
| Local state | `~/.tokimeter/calls.jsonl`, settings, cached pricing, queues, and generated helper metadata | The same `~/.tokimeter/` directory | Only the event allowlist above; queue/health internals and custom pricing files do not sync | API keys, local settings unrelated to event metadata, pricing files, shell config, backups |
| `tokimeter setup` | Existing Codex/Claude/Cursor config fields and shell PATH block, only to plan or preserve them | Generated files under `~/.tokimeter/`; Tokimeter Codex profiles; additive Claude/Cursor/Grok config; one marked shell PATH block with `--auto` | Nothing merely because setup ran | Existing config backups, shell contents, tool credentials |
| Local proxy (opt-in, experimental) | Provider request/response traffic needed to forward the call and read usage | Usage metadata and provider request ID in `~/.tokimeter/calls.jsonl`; request/response content is not logged | The same event metadata allowlist when Pro is explicitly connected | Authorization headers/API keys, prompt and response bodies, provider request ID |
| VS Code activity hint (optional) | Transient terminal output chunks for spinner/activity markers | Nothing; chunks are not buffered | Nothing | Terminal output |

`tokimeter report` and `tokimeter limits` use only the read-only paths — no
proxy, no shims, no writes outside `~/.tokimeter`.

## What Tokimeter stores

- All data lives in `~/.tokimeter/` on your machine: tracked call metadata
  (tokens, models, costs, project paths, session ids), settings, and a cached
  model-pricing table.
- **Prompt and response content is never stored.** The tracker records usage
  *metadata* only. Transcript files are parsed for their `usage` fields; the
  message text is not persisted by Tokimeter.
- The optional VS Code thinking-tip detector does not buffer terminal output.
  Disable `tokimeter.showTipsDuringWait` to turn off its transient activity
  check.

## What Tokimeter sends over the network

- **Nothing, by default.** No telemetry, no analytics, no phone-home.
- `tokimeter pricing refresh` (manual command) fetches a public model-price
  table over HTTPS and caches it locally.
- The optional proxy forwards your API traffic directly to the provider you
  configured (`api.openai.com`, `api.anthropic.com`, `api.venice.ai`, ...). It binds to
  `localhost` only and adds no third-party hops. Its paid-route accounting is
  experimental/test-covered, not yet reconciled against provider invoices.
- Cloud sync exists only if you explicitly set `TOKIMETER_CLOUD_URL` and
  `TOKIMETER_API_KEY`. Even then, only usage metadata is synced — never prompt
  or response content.

## API keys

- Tokimeter never logs or stores your API keys, and sends them only to the
  provider you configured. The proxy passes your `Authorization`/`x-api-key`
  headers through to that provider unchanged.
- Subscription-mode tracking (Claude Pro/Max, ChatGPT/Codex) involves no keys
  at all — it reads local files the vendor tools already write.

## Uninstall / footprint

- `tokimeter setup --dry-run` prints the exact planned files and process
  actions without mutating anything.
- `tokimeter uninstall` removes generated shims/helpers and restores supported
  Codex, Claude, and Cursor configuration fields that setup preserved.
- `rm -rf ~/.tokimeter` removes all stored data.
- Shims are plain shell scripts in `~/.tokimeter/bin` that `exec` the real
  tool — inspect them with `cat`.

The npm package declares no `install` or `postinstall` lifecycle script.
Configuration is an explicit `tokimeter setup` action, not an npm-install side
effect.

## Reporting a vulnerability

Report security issues privately through
[Tokimeter support](https://tokimeter.com/support/?topic=security). Do not open
a public issue containing vulnerability details. Please include reproduction
steps. We aim to respond within 72 hours.
