# npm release safety

Tokimeter's release workflow is stage-only by design. It does not contain
`npm publish`.

`.github/workflows/npm-staged-publish.yml` runs only through an explicit manual
dispatch. It checks out an existing tag, requires that tag to equal
`v<package.json version>`, requires the exact confirmation text, runs the
privacy/Python/Node/package gates, and then submits the tarball with
`npm stage publish`. The live npm version still requires a maintainer to review
and approve the staged package with 2FA.

The workflow uses:

- SHA-pinned GitHub-owned actions.
- `contents: read` plus job-local `id-token: write`.
- A GitHub-hosted runner and npm OIDC; no long-lived publish token.
- The `npm-staging` GitHub environment, which the owner can protect with
  required reviewers.
- npm's stage-only trusted-publisher permission, so CI cannot perform a live
  publish.

Owner setup required before first use:

1. In npm package settings, configure the trusted publisher for this repository
   and the exact workflow filename `npm-staged-publish.yml`.
2. Allow **stage publish only**, not live publish.
3. Protect the `npm-staging` GitHub environment and release tags.
4. After a reviewed version commit and tag exist, dispatch the workflow on that
   tag, inspect the staged tarball/provenance, and approve it with 2FA only when
   ready.

npm documents that trusted publishing requires npm 11.5.1+ and Node 22.14+,
uses short-lived OIDC credentials, and generates provenance automatically for
public packages from public repositories:
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[staged publishing](https://docs.npmjs.com/staged-publishing/).

The `tokimeter` package itself declares no `install` or `postinstall` lifecycle
script. Its `prepack`/`postpack` scripts only assemble and clean the bundled
core during packaging; user configuration remains an explicit,
previewable `tokimeter setup` action.
