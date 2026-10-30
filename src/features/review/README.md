# review

`yoke review [number]` reviews the current branch's PR, or PR `<number>`, with two independent reviewers, then a synthesis pass combines, de-duplicates and ranks their findings. Reviewers run at the PR's head, in a temporary worktree unless your checkout is already there and clean. Each run is cached per PR base and head commit, so re-running reuses finished steps. With `--post`, findings go to the PR as one GitHub review: inline comments on diff lines, the rest in the review body, skipping findings already raised.

## Parameters

| Parameter | Description |
|---|---|
| `[number]` | PR to review. Default: the current branch's PR. |
| `--post` | Post the findings as one GitHub review, reusing the saved review when there is one. |
| `--force` | Discard the cached reviews and run every pass again. |
| `--verbose` | Print each step and reviewer tool call as log lines instead of spinners. |

## Settings

Slots are `reviewer1`, `reviewer2` and `synthesis`.

| Setting | Description |
|---|---|
| `review.<slot>.harness` | `claude` or `codex`. Defaults: `claude`, `codex`, reviewer1's harness. |
| `review.<slot>.provider` | `litellm` or `foundry`. Unset: your own CLI login. |
| `review.<slot>.model` | Model to run; required with a provider. See `yoke models`. |
