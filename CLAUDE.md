## README

The root README must not grow with each feature. Each skill under `## Skills` gets one short sentence saying what it does, like the `/pr` entry. No feature sections, feature flags or settings, cache paths or internals there; those go in that feature's `src/features/<feature>/README.md`. Concerns shared by every feature (how config works, model providers) stay in the root README's `## Configuration`, and feature READMEs don't repeat them.

## Verification

After making code changes, run `/verify` and fix everything it reports before committing. Don't silence checks or game the metrics.
