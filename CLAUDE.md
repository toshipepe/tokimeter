# Claude Code project instructions

Read and follow `AGENTS.md` and `CONTRIBUTING.md` before changing files.
`AGENTS.md` is the canonical repository policy and applies in full.

Critical rules:

- This is the public local-first CLI repository, not the private hosted product.
- Never add hosted website, Supabase server, billing, Cloudflare, secret,
  customer, contact-recipient, private handoff, prompt/response, real-log, or
  personal-path material.
- Keep private working material in ignored `.local/`, `.codex/`, `.agents/`, or
  `.claude/` paths and never force-add it.
- Work on a branch, stage exact files, review the staged diff, and merge through
  a protected pull request.
- Run `node scripts/privacy-check.mjs --precommit` before committing or pushing.
  Do not use `--no-verify` or weaken the privacy gate.
- Do not publish npm, change repository visibility/history, archive/delete a
  repository, or deploy hosted services without explicit user approval.
