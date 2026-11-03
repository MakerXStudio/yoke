# review

Two reviewers review a PR independently, then a third pass combines and ranks their findings.

## Parameters

| Parameter | Description |
|---|---|
| `[number]` | PR to review. Default: the current branch's PR. |
| `--post` | Post the findings as one GitHub review, reusing the saved review when there is one. |
| `--force` | Discard the cached reviews and run every pass again. |
| `--verbose` | Print each step and reviewer tool call as log lines instead of spinners. |
| `--head <sha>` | Refuse to review unless the PR's head is this commit. CI passes the commit a maintainer approved on a fork PR. |

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

The reusable workflow `.github/workflows/review.yml` runs `yoke review --post` on each PR, with every slot on one LiteLLM or Foundry provider. It skips drafts and bots, and runs on a fork PR only once a maintainer [approves it](#fork-prs).

`yoke review-ci` (or `/review-ci`) writes the caller below to `.github/workflows/review-pr.yml` and prints the commands to set its variable and secret, then points to `/review-ci-gate` for the [merge gate](#merge-gate). `--print` shows them without saving anything. It never replaces a `review-pr.yml` that differs from its version; it stops and says to edit that file in place.

When the repo already has a workflow that reviews PRs with an LLM, whatever tool it uses, `/review-ci` edits that file in place so it runs yoke's review, keeping its provider, models, base URL, variable and secret names and other local changes. If the file already runs yoke's review, it only adds what is missing.

The caller:

```yaml
name: Review PR

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_target:
    types: [labeled, synchronize]

permissions:
  actions: write
  contents: read
  pull-requests: write
  statuses: write

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

The `review / gate` check blocks merging until the PR's latest review succeeds, whatever it found. It fails while that review errored or none has completed, and passes for bots, which never get one. It runs on every push.

For a PR from a fork, the gate fails until a review a maintainer approved succeeds for the PR's head commit. See [Fork PRs](#fork-prs).

`/review-ci-gate` (or `yoke review-ci-gate`) adds a ruleset requiring the check on the default branch. It first checks that the caller workflow is merged there with the `synchronize` trigger, the `pull_request_target` `labeled` and `synchronize` triggers, `actions: write` and `statuses: write`, and no `paths` or branch filters that skip PRs to it, and that the gate has reported on a recent PR; otherwise it creates nothing and says what to fix.

### Fork PRs

The review doesn't run automatically on a PR from a fork: it needs the repo's secrets, and its reviewers run on the fork's code. The gate fails for the PR, telling a maintainer to read the diff and add the `review` label.

> [!WARNING]
> Adding the `review` label runs Claude and Codex, with `REVIEW_CI_API_KEY` (or the Entra app's token) and a GitHub token that can write to the repo's PRs, statuses and Actions runs, on the fork's code. Read the whole diff first, including workflows, scripts, `.npmrc`, `.claude/` settings and hooks, `.mcp.json`, `.codex/` config and any instructions aimed at an AI agent, and add the label only when nothing in it could leak a secret or misuse that token.

Adding the label runs the review on `pull_request_target`, which takes the workflow from the PR's base branch. The job checks out the base branch, so `npm` and `npx` never read the fork's config, and yoke reviews the labelled commit in a separate worktree, running Claude with `--setting-sources user --strict-mcp-config` so the fork's settings, hooks and MCP servers don't load. It reviews only that commit: if the fork pushed after the label was added, the review fails without running. It posts its findings like any other review.

`pull_request_target` checks attach to the base branch's commit, not the PR's, so the review job first marks the `review / approved review` commit status on the PR's head commit as pending, and the gate job on that run records the outcome there when it finishes. Each time, it then re-runs the `review / gate` job of that commit's `pull_request` run. The gate reads that status and passes once the approved review succeeded, without anyone pushing again. To re-run a failed approved review, remove the label and add it again.

An approval covers only the commit that was labelled. When the fork pushes again, the `unapprove` job on the `pull_request_target` `synchronize` event runs `yoke review-unapprove`, which removes the `review` label, and the gate fails for the new head until a maintainer reads the new commits and adds the label again.

### Foundry with Entra auth

For a Foundry resource that rejects API keys, sign in as an Entra app with the job's GitHub OIDC token:

```sh
yoke review-ci --provider foundry --azure-client-id <id> --azure-tenant-id <id> [--environment <name>]
```

`yoke review-ci` then prints the federated credential to add to the app. The app also needs the Cognitive Services User role on the Foundry resource.
