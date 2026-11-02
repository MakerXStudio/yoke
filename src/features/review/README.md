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

The reusable workflow `.github/workflows/review.yml` runs `yoke review --post` on each PR, with every slot on one LiteLLM or Foundry provider. It skips drafts, forks and bots.

`yoke review-ci` (or `/review-ci`) writes the caller below to `.github/workflows/review-pr.yml` and prints the commands to set its variable, secret and [merge gate](#merge-gate) ruleset. `--print` shows them without saving anything. It never replaces a `review-pr.yml` that differs from its version; it stops and says to edit that file in place.

When the repo already has a workflow that reviews PRs with an LLM, whatever tool it uses, `/review-ci` edits that file in place so it runs yoke's review, keeping its provider, models, base URL, variable and secret names and other local changes. If the file already runs yoke's review, it only adds what is missing.

The caller:

```yaml
name: Review PR

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  actions: read
  contents: read
  pull-requests: write

jobs:
  review:
    uses: MakerXStudio/yoke/.github/workflows/review.yml@main
    with:
      reviewer1-model: bedrock/claude-opus-5-5
      reviewer2-model: azure/gpt-6.1-sol
      base-url: ${{ vars.REVIEW_CI_BASE_URL }}
    secrets:
      REVIEW_CI_API_KEY: ${{ secrets.REVIEW_CI_API_KEY }}
```

| Input | Description |
|---|---|
| `provider` | `litellm` or `foundry`. Default: `litellm`. |
| `base-url` | LiteLLM proxy URL, or `https://<resource>.services.ai.azure.com` for Foundry. |
| `reviewer1-harness`, `reviewer2-harness` | `claude` or `codex`. Defaults: `claude`, `codex`. |
| `reviewer1-model`, `reviewer2-model` | Required. See `yoke models`. |
| `synthesis-harness`, `synthesis-model` | Default: reviewer 1's. |
| `yoke-version` | `@makerx/yoke` version to run. Default: `latest`. |
| `azure-client-id`, `azure-tenant-id` | Entra app to reach Foundry as, in place of `REVIEW_CI_API_KEY`. See below. |
| `environment` | GitHub environment the review job runs in. |

In CI, `yoke review --post` always posts a review, even with no findings, and a failed reviewer or synthesis posts `## Code review failed`. Locally it posts nothing new and synthesises from one reviewer if the other fails. To re-run a CI review, mark the PR as draft, then ready for review.

### Merge gate

The `review / gate` check blocks merging until the PR's latest review succeeds, whatever it found. It fails while that review errored or none has completed, and passes for forks and bots, which never get one. It runs on every push, so require it with the ruleset `yoke review-ci` prints, once the caller is merged.
### Foundry with Entra auth

For a Foundry resource that rejects API keys, sign in as an Entra app with the job's GitHub OIDC token:

```sh
yoke review-ci --provider foundry --azure-client-id <id> --azure-tenant-id <id> [--environment <name>]
```

`yoke review-ci` then prints the federated credential to add to the app. The app also needs the Cognitive Services User role on the Foundry resource.
