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

The reusable workflow `.github/workflows/review.yml` runs `yoke review --post` on each non-draft PR opened from the same repo. Every slot goes through one LiteLLM or Foundry provider.

`yoke review-ci` (or `/review-ci`) sets up a repo:

- Writes the caller below to `.github/workflows/review-pr.yml`, with each slot's harness and model from your settings or its flags.
- Prints the `gh secret set` commands for `REVIEW_CI_BASE_URL` and `REVIEW_CI_API_KEY`.
- `--provider foundry` uses Foundry, with an API key or [Entra auth](#foundry-with-entra-auth).
- `--force` replaces an existing caller.

By hand, set the secrets, then call it:

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
    secrets:
      REVIEW_CI_BASE_URL: ${{ secrets.REVIEW_CI_BASE_URL }}
      REVIEW_CI_API_KEY: ${{ secrets.REVIEW_CI_API_KEY }}
```

| Input | Description |
|---|---|
| `provider` | `litellm` or `foundry`. Default: `litellm`. |
| `reviewer1-harness`, `reviewer2-harness` | `claude` or `codex`. Defaults: `claude`, `codex`. |
| `reviewer1-model`, `reviewer2-model` | Required. See `yoke models`. |
| `synthesis-harness`, `synthesis-model` | Default: reviewer 1's. |
| `yoke-version` | `@makerx/yoke` version to run. Default: `latest`. |
| `azure-client-id`, `azure-tenant-id` | Entra app to reach Foundry as, in place of `REVIEW_CI_API_KEY`. See below. |
| `environment` | GitHub environment the review job runs in. |

### Foundry with Entra auth

A Foundry resource with local auth disabled rejects API keys. Use an Entra app instead:

```sh
yoke review-ci --provider foundry --azure-client-id <id> --azure-tenant-id <id> [--environment <name>]
```

The caller then grants `id-token: write`, passes those as inputs, and passes only `REVIEW_CI_BASE_URL`. The job exchanges its GitHub OIDC token for a masked Entra token, which both harnesses and the preflight probe send to Foundry as a bearer token.

Instead of the `REVIEW_CI_API_KEY` command, `yoke review-ci` prints the federated credential to add to the app, with an `az ad app federated-credential create` command for it:

| Field | Value |
|---|---|
| Issuer | `https://token.actions.githubusercontent.com` |
| Audience | `api://AzureADTokenExchange` |
| Subject | `repo:<owner>/<repo>:environment:<environment>` with `--environment`, else `repo:<owner>/<repo>:pull_request` |

The app also needs the Cognitive Services User role on the Foundry resource.

In CI (`GITHUB_ACTIONS=true`), `yoke review --post` always posts a review, ending with a note that marking the PR as draft and then ready for review re-runs it:

- No new findings: the summary and `No new findings were raised.`
- A reviewer or the synthesis fails: a `## Code review failed` review linking the workflow run, and a non-zero exit.
- With `GITHUB_STEP_SUMMARY` set, the review summary and a token usage table per step go to the job summary.

Locally it posts nothing when there's nothing new, and synthesises from one reviewer if the other fails.
