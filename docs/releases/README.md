# Release notes staging

Drafts for GitHub Releases. Tags v0.2.1–v0.2.3 are already pushed at the
real historical commits. To publish the releases (they carry over when the
repo goes public):

    gh release create v0.2.3 --title "v0.2.3 — plan, agent breakdowns, orchestration" --notes-file docs/releases/v0.2.3.md
    gh release create v0.2.2 --title "v0.2.2 — savings, burn, trace, export" --notes-file docs/releases/v0.2.2.md

v0.3.0 notes are ready in v0.3.0.md; publish it `--latest`. Exact commands are
in docs/REPO_METADATA.md §7.
