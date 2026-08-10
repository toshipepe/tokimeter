# Contributing to Tokimeter

Thanks for looking! Tokimeter is a local-first usage/cost meter for AI coding
agents. The core rule that shapes every contribution:

> **Metadata only, honest numbers.** Tokimeter reads token/usage metadata the
> tools already write locally. It never reads prompt or response content, never
> makes an extra model call, and marks every estimate `~$` (API-equivalent, not
> a bill). Verify pricing against official provider docs. Prefer factual wording
> over advice ("this could run cheaper" not "you should switch").

## Adding support for a new coding agent

This is the most common contribution, and the most welcome. The pattern:

1. Find where the tool writes usage metadata locally (a JSONL log, a SQLite db,
   a per-session JSON dir). Document the format in a fixture.
2. Add a pure reader in `ts/packages/proxy/src/parsers.js` that maps its records
   to Tokimeter events (see `opencodeMessageToEvent` / `readOpencodeMessageFile`
   as a template — small, fixture-tested, no I/O in the mapper).
3. Wire a `collect<Tool>UsageEvents` walker into `collectLocalUsageEvents` in
   `ts/packages/proxy/src/cli.js`, gated on the `--tool <name>` filter.
4. Add fixtures + tests in `ts/test/parsers.test.js`, including a "no PII" test
   if the source file also contains prompt content.
5. Update the README "Other tools" section.

Only numeric usage fields belong on an event. If a source file mixes usage with
request text, parse out only the numbers.

## Development

```bash
cd ts && npm install
npm run privacy:setup             # once per clone: enable the repository hooks
npm test                        # JS parser/pace tests (node:test)
cd .. && python3 tests/test_basic.py   # Python pricing tests
node ts/packages/proxy/src/cli.js report --days=7   # run against your own logs
```

Keep both test suites green. CI runs them on every push.

## Privacy checks

Run `npm run privacy:check` from `ts/` before opening a pull request. The same
gate runs in CI, before local commits and pushes after `privacy:setup`, and
before npm publishing. It rejects unapproved email addresses, user-directory
paths, common secrets, private workspace files, and unexpected npm tarball
files. Use reserved `example.com`, `example.net`, or `example.org` addresses in
fixtures and documentation.

Your commit email is your own choice. The Git identity rule applies only to
commits authored under the maintainer's name, so you do not need to change your
public commit address to contribute. If you would rather keep your address
private, GitHub's `@users.noreply.github.com` option works and needs nothing
from us.

## Style

- Match the surrounding code; no framework, no build step for the CLI.
- No AI-looking em-dashes in README/site copy (commas, periods, colons; compound
  hyphens like `local-first` are fine).
- Commit messages are plain and imperative; no AI attribution trailers.

## Reporting bugs / security

- Bugs: open an issue with reproduction steps and your `tokimeter doctor` output.
- Security: see [SECURITY.md](SECURITY.md) — please don't file public exploit
  details in a normal issue.
