# Tokimeter repository agent instructions

These instructions apply to the entire repository. This is the public,
open-source Tokimeter CLI repository. Treat every tracked file and every
reachable Git commit as public.

## Privacy and repository boundaries

- Keep this repository limited to the local-first CLI, its public SDK/editor
  code, tests, fixtures, and public documentation.
- Never add the private website or dashboard source, Supabase server functions
  or service credentials, billing implementation, Cloudflare configuration,
  contact-form recipient addresses, private launch plans, or operational
  handoffs. Those belong only in the private `tokimeter-cloud` repository or in
  ignored local working directories.
- Never commit secrets, access tokens, environment files, private keys,
  credentials, personal email addresses, real customer data, prompt or response
  content, real user logs, or non-synthetic home-directory paths.
- Use reserved example addresses and synthetic paths in tests and documentation.
  Approved public Git identities are GitHub noreply addresses and the project
  address already enforced by `scripts/privacy-check.mjs`.
- Keep private notes, agent state, temporary worktrees, audits, and handoffs in
  ignored paths such as `.local/`, `.codex/`, `.agents/`, or `.claude/`. Never
  force-add an ignored private file.
- Do not modify unrelated repositories, Cloudflare projects, or hosted services
  while working in this repository.

## Git and review safety

- Work on a feature branch and merge through a pull request. Do not push
  directly to `main`.
- Never force-push or rewrite the public repository history without a new,
  explicit user decision.
- Stage exact reviewed paths. Do not use broad commands such as `git add .`.
- Before committing, review `git status --short` and `git diff --cached`.
- Run `node scripts/privacy-check.mjs --precommit` before committing or pushing.
- Enable the repository hooks once in every fresh clone with
  `cd ts && npm run privacy:setup`. Do not bypass them with `--no-verify`.
- If the privacy gate fails, fix the cause. Do not weaken the check merely to
  make a commit or release pass.

## Release and deployment safety

- Do not publish, deprecate, unpublish, rename, or transfer the npm package
  without explicit user approval for that specific action.
- Do not create or replace GitHub releases, change repository visibility,
  archive/delete repositories, or deploy the hosted website without explicit
  user approval.
- Never deploy directly to Cloudflare from this public repository. The website
  is deployed from the private `tokimeter-cloud` repository through its
  existing integration.

## Required verification

For code changes, run the checks relevant to the files changed. Before a public
release or security-sensitive merge, run all of:

```text
node scripts/privacy-check.mjs --ci
python3 tests/test_basic.py
cd ts && npm test
```

Preserve the required GitHub Privacy gate, Python tests, Node build, CodeQL,
secret scanning, push protection, and branch protection.
