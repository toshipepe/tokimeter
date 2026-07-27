# Changelog

All notable changes to the Tokimeter VS Code extension.

## 0.1.0 — unreleased

Initial release.

- Status bar with today's spend and the latest model used.
- Cost dashboard webview with All / Claude / Codex filters, today's totals,
  and by-tool / by-model / by-project breakdowns. `~$X` always marks
  API-equivalent estimates; billed proxy usage shows plain `$X`.
- One-click actions: run local setup, readiness check, start/stop proxy,
  open watch terminal, import Codex rollouts, import Claude transcripts.
- Rotating local cost tips while AI tools are thinking (optional).
- Optional daily budget warning (`tokimeter.dailyBudget`), local only.

Everything is read from the local Tokimeter proxy (`http://localhost:8788`).
No prompts or code ever leave your machine — the extension only displays
usage metadata (tokens, models, costs, project paths). When thinking tips are
enabled, terminal output is checked transiently for activity markers and is
never retained.
