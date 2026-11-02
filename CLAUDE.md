## README

The root README must not grow with each feature. Each skill under `## Skills` gets one short sentence saying what it does, like the `/pr` entry. No feature sections, feature flags or settings, cache paths or internals there; those go in that feature's `src/features/<feature>/README.md`. Concerns shared by every feature (how config works, model providers) stay in the root README's `## Configuration`, and feature READMEs don't repeat them.

## Workflows

The reusable `.github/workflows/review.yml` runs in every caller's repo, so its steps only install tools and call `yoke`. Put any logic (checks, API calls, decisions) in a yoke command with tests, not in a `run:` script. A test fails any `run:` step over two lines.

## Verification

After making code changes, run `/verify` and fix everything it reports before committing. Don't silence checks or game the metrics.

## Pull requests

PR titles must be conventional commits (`feat: …`, `fix: …`, `chore: …`); the `title` CI check rejects any other title.
