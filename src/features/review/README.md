# review

Two reviewers review a PR independently, then a third pass combines and ranks their findings.

## Parameters

| Parameter | Description |
|---|---|
| `[number]` | PR to review. Default: the current branch's PR. |
| `--post` | Post the findings as one GitHub review, reusing the saved review when there is one. |
| `--force` | Discard the cached reviews and run every pass again. |
| `--verbose` | Print each step and reviewer tool call as log lines instead of spinners. |

## Settings

Unset, reviewers run `claude` and `codex` on your own logins. To pick models, or run a reviewer through LiteLLM:

```bash
# pick each reviewer's model on your own login
yoke config set --user review.reviewer1.model opus
yoke config set --user review.reviewer2.model gpt-5.1-codex

# or run reviewer 2 through LiteLLM
yoke config set --user litellm.baseUrl https://llm.example.com
yoke config set --user litellm.apiKey <key>
yoke models   # list the models LiteLLM serves
yoke config set --user review.reviewer2.provider litellm
yoke config set --user review.reviewer2.model azure-us/gpt-5.1-codex
```

Slots are `reviewer1`, `reviewer2` and `synthesis`.

| Setting | Description |
|---|---|
| `review.<slot>.harness` | `claude` or `codex`. Defaults: `claude`, `codex`, reviewer1's harness. |
| `review.<slot>.provider` | `litellm` or `foundry`. Unset: your own CLI login. |
| `review.<slot>.model` | Model to run; required with a provider. See `yoke models`. |

## CI

The reusable workflow `.github/workflows/review.yml` runs `yoke review --post` on each non-draft PR opened from the same repo, with every slot going through one LiteLLM or Foundry provider. `yoke review-ci` (or `/review-ci`) writes the caller below to `.github/workflows/review-pr.yml`, taking each slot's harness and model from your settings or its flags, and prints the `gh secret set` commands for the `REVIEW_CI_BASE_URL` and `REVIEW_CI_API_KEY` secrets. Pass `--provider foundry` to use Foundry, and `--force` to replace an existing caller. By hand, set the secrets, then call it:

```yaml
name: Review PR

on:
  pull_request:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: MakerXStudio/yoke/.github/workflows/review.yml@main
    with:
      reviewer1-model: bedrock/claude-opus-5-5
      reviewer2-model: azure/gpt-6.1-sol
    secrets: inherit
```

| Input | Description |
|---|---|
| `provider` | `litellm` or `foundry`. Default: `litellm`. |
| `reviewer1-harness`, `reviewer2-harness` | `claude` or `codex`. Defaults: `claude`, `codex`. |
| `reviewer1-model`, `reviewer2-model` | Required. See `yoke models`. |
| `synthesis-harness`, `synthesis-model` | Default: reviewer 1's. |
| `yoke-version` | `@makerx/yoke` version to run. Default: `latest`. |
