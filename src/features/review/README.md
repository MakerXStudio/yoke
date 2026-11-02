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
- Prints the `gh variable set` command for the `REVIEW_CI_BASE_URL` variable and the `gh secret set` command for the `REVIEW_CI_API_KEY` secret.
- Prints the `gh api` command that adds a ruleset requiring the [`review / gate`](#merge-gate) check on the default branch.
- `--provider foundry` uses Foundry, with an API key or [Entra auth](#foundry-with-entra-auth).
- `--force` replaces an existing caller.

By hand, set the variable and secret, then call it:

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
| `base-url` | LiteLLM proxy URL, or `https://<resource>.services.ai.azure.com` for Foundry. Not sensitive, so keep it in a variable. Callers that still pass it as the `REVIEW_CI_BASE_URL` secret keep working. |
| `reviewer1-harness`, `reviewer2-harness` | `claude` or `codex`. Defaults: `claude`, `codex`. |
| `reviewer1-model`, `reviewer2-model` | Required. See `yoke models`. |
| `synthesis-harness`, `synthesis-model` | Default: reviewer 1's. |
| `yoke-version` | `@makerx/yoke` version to run. Default: `latest`. |
| `azure-client-id`, `azure-tenant-id` | Entra app to reach Foundry as, in place of `REVIEW_CI_API_KEY`. See below. |
| `environment` | GitHub environment the review job runs in. |

### Merge gate

Findings are advisory `COMMENT` reviews and never block a merge. A review job that fails (missing settings, or a reviewer or the synthesis failing) does, through the `gate` job in the reusable workflow, which reports as `review / gate`:

- When the review ran on this event, the gate passes or fails with it.
- When the review was skipped (a push, a draft, a fork or a bot), the gate looks back through the caller's earlier runs for this PR and takes the result of the latest one whose review job ran, waiting for it if it's still running. With no such run it passes, so fork and bot PRs, which never get a review, aren't blocked.
- Pushes (`synchronize`) run only the gate, not the review, so each new head commit gets a status. A failed review keeps blocking until it's re-run by marking the PR as draft, then ready for review.

The gate reads the run history with the caller's `actions: read` permission, since a settings failure exits before posting any review.

Requiring the check takes a branch ruleset. `yoke review-ci` prints the command, which runs against the current repo:

```sh
echo '{"name":"yoke review","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"rules":[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"review / gate"}]}}]}' | gh api --method POST 'repos/{owner}/{repo}/rulesets' --input -
```

Add it only after the caller with `synchronize` is merged to the default branch; before that, pushes to open PRs get no `review / gate` status and stay stuck waiting for one.

To migrate a repo set up before the gate: run `yoke review-ci --force` to rewrite the caller with `synchronize` and `actions: read`, merge it, then add the ruleset.

### Foundry with Entra auth

A Foundry resource with local auth disabled rejects API keys. Use an Entra app instead:

```sh
yoke review-ci --provider foundry --azure-client-id <id> --azure-tenant-id <id> [--environment <name>]
```

The caller then grants `id-token: write`, passes those as inputs alongside `base-url`, and passes no secrets. `yoke review` reads them as `foundry.azureClientId` and `foundry.azureTenantId` and exchanges the job's GitHub OIDC token for a masked Entra token, which both harnesses and the preflight probe send to Foundry as a bearer token.

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
