# review

Two reviewers review a PR independently, then a third pass combines and ranks their findings.

Reviews are static: reviewers read the code and don't run the PR's tests or builds.

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

The reusable workflow `.github/workflows/review.yml` runs `yoke review --post` on each PR when it is opened, reopened or marked ready for review, with every slot on one LiteLLM or Foundry provider. A push runs it only when no earlier run of the workflow has started a review for the PR or is still deciding whether to, such as when GitHub skipped the ready-for-review run because the PR had merge conflicts; re-running all jobs in that push's run also runs it (re-running only the failed gate does not). It skips drafts and bots, and runs on a fork PR only once a maintainer [approves it](#fork-prs).

`yoke review ci` (or `/review-ci`) writes the caller below to `.github/workflows/review-pr.yml` and prints the commands to set its variable and secret, then points to `/review-ci-gate` for the [merge gate](#merge-gate). `--print` shows them without saving anything. It never replaces a `review-pr.yml` that differs from its version; it stops and says to edit that file in place.

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
    uses: MakerXStudio/yoke/.github/workflows/review.yml@review-v<version>
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
| `azure-client-id`, `azure-tenant-id` | Entra app to reach Foundry as, in place of `REVIEW_CI_API_KEY`. See below. |
| `environment` | GitHub environment the review job runs in. |
| `yoke-from-source` | `true` runs yoke built from the yoke commit `uses:` resolved to, instead of the locked release, to test an unreleased yoke branch. Default: `false`. See [Verified installs](#verified-installs). |
| `review-app-client-id` | Experimental: the `yoke-review` App's client ID, with its `YOKE_REVIEW_APP_PRIVATE_KEY` secret. See [Risk-based approval](#risk-based-approval). |

In CI, `yoke review --post` always posts a review, even with no findings, and a failed reviewer or synthesis posts `## Code review failed`. Locally it posts nothing new and synthesises from one reviewer if the other fails. To re-run a CI review, mark the PR as draft, then ready for review.

### Verified installs

CI installs yoke, Claude Code and Codex with `npm ci` from `ci/review-tools/package-lock.json`, checked out from yoke at `job.workflow_sha` (the commit the caller's `uses:` resolved to). npm verifies every package's `sha512` hash.

On a `pull_request` run in `MakerXStudio/yoke` itself, same-repo or fork, each job also builds yoke from that same `job.workflow_sha` and puts it ahead of the locked yoke on `PATH`, so a PR that adds a yoke command and calls it from `review.yml` is tested with that command before it merges and is released. Claude Code and Codex still come from the lockfile. This adds no trust: whoever can open the PR already controls the `review.yml` that run uses, and a fork's `pull_request` run has no secrets and a read-only token. A caller can do the same with `yoke-from-source: true`, to test an unreleased yoke branch, e.g. `uses: MakerXStudio/yoke/.github/workflows/review.yml@<branch>`, on its own PRs before that branch merges. This adds no trust either: the caller already runs that commit's `review.yml` and lockfile. `pull_request_target` runs, and other repos without the input, use only the locked yoke, so a maintainer-approved fork review never runs fork code.

Pin `uses:` to a `review-v<version>` tag to run that yoke version; `/review-ci` writes the tag of the yoke that runs it. Releases before this tag existed have none. A release tag `vN` locks the previous yoke, because the lock can only be written once `vN` is published, and `@main` runs whatever yoke `main` locks, which can lag the workflow on it.

Each release commits the newly published yoke to the lockfile, tags that commit `review-vN` and pushes the tag, then pushes the commit to `main`, as the `yoke-release` GitHub App. If the latest `vN` has no `review-vN`, because its lock step failed, the next run of the release workflow, on a push to `main` or a manual dispatch, locks it from `vN`. The App bypasses the `main` ruleset. Its client ID and private key live in the `release` environment, which only `main` can use. Dependabot bumps Claude Code and Codex weekly.

### Merge gate

The `review / gate` check blocks merging until the PR's latest review succeeds, whatever it found. It fails while that review errored or none has completed, and passes for bots, which never get one. It runs on every push, waiting for a review still running in an earlier run; a push to a PR with no review started runs one, and the gate reads its result.

For a PR from a fork, the gate fails until a review a maintainer approved succeeds for the PR's head commit. See [Fork PRs](#fork-prs).

`/review-ci-gate` (or `yoke review ci-gate`) adds a ruleset requiring the check on the default branch. It first checks that the caller workflow is merged there with the `synchronize` trigger, the `pull_request_target` `labeled` and `synchronize` triggers, `actions: write` and `statuses: write`, and no `paths` or branch filters that skip PRs to it, and that the gate has reported on a recent PR; otherwise it creates nothing and says what to fix.

### Fork PRs

The review doesn't run automatically on a PR from a fork: it needs the repo's secrets, and its reviewers run on the fork's code. The gate fails for the PR, telling a maintainer to read the diff and add the `review` label.

> [!WARNING]
> Adding the `review` label runs Claude and Codex, with `REVIEW_CI_API_KEY` (or the Entra app's token) and a GitHub token that can write to the repo's PRs, statuses and Actions runs, on the fork's code. Read the whole diff first, including workflows, scripts, `.npmrc`, `.claude/` settings and hooks, `.mcp.json`, `.codex/` config and any instructions aimed at an AI agent, and add the label only when nothing in it could leak a secret or misuse that token.

Adding the label runs the review on `pull_request_target`, which takes the workflow from the PR's base branch. Only a label from a user with write, maintain or admin access approves the review; triage access can add labels, but then the review doesn't run and the `review / approved review` status says who added the label and the access it needs. The job checks out the base branch, so `npm` and `npx` never read the fork's config, and yoke reviews the labelled commit in a separate worktree, running Claude with `--setting-sources user --strict-mcp-config` so the fork's settings, hooks and MCP servers don't load. It reviews only that commit: if the fork pushed after the label was added, the review fails without running. It posts its findings like any other review.

`pull_request_target` checks attach to the base branch's commit, not the PR's, so the review job first marks the `review / approved review` commit status on the PR's head commit as pending, and the gate job on that run records the outcome there when it finishes. Each time, it then re-runs the `review / gate` job of that commit's `pull_request` run. A run leaves the status alone when it already belongs to a newer approved review, so overlapping runs can't record an older result over a newer one. The gate reads that status and passes once the approved review succeeded, without anyone pushing again. To re-run a failed approved review, remove the label and add it again.

An approval covers only the commit that was labelled. When the fork pushes again, the `unapprove` job on the `pull_request_target` `synchronize` event runs `yoke review unapprove`, which removes the `review` label, and the gate fails for the new head until a maintainer reads the new commits and adds the label again.

### Risk-based approval

> [!WARNING]
> Experimental. It approves PRs with no human review; its rules and inputs may change.

With a `.github/yoke-risk.yml` policy on the default branch and the `yoke-review` GitHub App configured, the review job runs `yoke review risk` after posting the review. It rates the PR's risk from the files it changes and the synthesis's AI risk rating and, when that is low, approves the PR as `yoke-review[bot]`, and in `merge` mode enables auto-merge, so it needs no human tick. Everything else waits for a human as before. Without the policy file the step logs that risk review is off and changes nothing.

```yaml
# .github/yoke-risk.yml
mode: approve
# mergeMethod: squash
lowRisk:
  - '**/*.{tsx,md}'
alwaysHuman:
  - 'src/auth/**'
  - 'infra/**'
author:
  minMergedPrs: 1
trusted:
  - alice
  - MakerXStudio/leads
sample:
  rate: 0.1
  reviewers:
    - MakerXStudio/leads
```

| Key | Description |
|---|---|
| `mode` | `approve` approves a low-risk PR. `merge` also enables auto-merge on it as the App. Default: `approve`. |
| `mergeMethod` | `merge`, `squash` or `rebase`, for `merge` mode. Default: the first the repo allows of `squash`, `merge` and `rebase`. |
| `lowRisk` | Globs no one needs to eyeball. |
| `alwaysHuman` | Globs that always need a human. |
| `author.minMergedPrs` | Merged PRs in the repo the author needs, at least 1. Fewer makes them a first-time author. Default: `1`. |
| `trusted` | Logins, and `org/team-slug` teams, exempt from `minMergedPrs`. Default: none. |
| `sample.rate` | Share of auto-approved PRs, from 0 to 1, sent to a human for a check. Default: `0`. |
| `sample.reviewers` | Logins, and `org/team-slug` teams in the repo's org, asked to review a sampled PR. Default: none. |
| `sample.label` | Label added to a sampled PR. Default: `yoke-risk-sampled`. |

The policy is always read from the default branch through the API, never from the PR, so a PR can't loosen its own rating. The rating:

- **high** when any changed file, or a renamed file's old path, matches `alwaysHuman` or a built-in exclusion the policy can't remove: `.github/**` (workflows and the policy itself), `.claude/**`, `.codex/**` and `.mcp.json`, at any depth for the last three.
- **low** when every changed file matches `lowRisk`.
- otherwise the synthesis's AI risk rating decides: `low`, `medium` or `high` with a one-sentence reason, rating the risk of merging the change unread. Only `low` can be approved, and a missing or unreadable rating leaves the PR **undecided**, which needs a human. The AI can't lower a high rating from the globs or raise an all-`lowRisk` one.

A low-risk PR is approved only when the review on this run succeeded and raised no `blocker` or `major` finding, including ones already raised earlier, the PR is from the repo itself, not a fork, and not from a bot, and its author passes the track-record check. The approval is submitted on the head commit the review was posted on.

The track-record check searches the author's merged PRs in the repo. A first-time author, with fewer than `author.minMergedPrs`, is never low risk. Repo admins, required reviewers of any deployment environment (directly or through a team), and anyone listed in `trusted` are exempt from this rule. Team membership is read with the App, so without it team exemptions can't be checked. The outcome is shown as **Author** in the `## Risk` section, on every PR.

In `merge` mode, after approving, the App enables auto-merge bound to the approved head commit. It leaves auto-merge someone already enabled as it is, and records in the `## Risk` section when the repo doesn't allow auto-merge or GitHub refuses it.

When a later run on the PR is not approved, for a push that is no longer low risk or a review that failed, the App dismisses its earlier approvals and disables the auto-merge it enabled, and lists both under **Actions** in the `## Risk` section. A push the review skips, because a review already started for the PR, isn't rated, so the `push` job does the same and logs it. Auto-merge someone else enabled is left alone.

Every review posted in a repo with a policy, failed reviews included, gets a `## Risk` section with the decision, its reasons (including the AI rating and whether it was used), the head commit SHA, and the policy file's commit SHA on the default branch. The approval carries the same section. A step failure never fails the review job.

`yoke review ci --risk` adds the App's input and secret to the caller, writes an example `.github/yoke-risk.yml` if there is none, and prints the App permissions and repo settings below. With `--print` it prints the example policy instead.

To set it up, run `/review-ci-risk` once `/review-ci`'s workflow is merged. It runs `yoke review ci-risk`, drafts a `.github/yoke-risk.yml` from the repo's layout (`mode`, `lowRisk` and `alwaysHuman` globs naming the repo's own paths) for your sign-off, commits it with the caller's App lines and raises the setup PR, then lists only the steps that need an org owner or repo admin. Run it again once the PR is merged and a PR has been reviewed to confirm the setup.

`yoke review ci-risk` checks each requirement against GitHub and prints a pass or fail line, with a link, for each, exiting non-zero until all pass. `yoke review ci-risk --example-policy` prints an example policy, with comments, and checks nothing. The requirements:

- **Gate:** `review / gate` is required on the default branch. It requires it itself, as `ci-gate` does, and otherwise shows `ci-gate`'s reason.
- **Workflow:** the default branch's caller passes `review-app-client-id` and `YOKE_REVIEW_APP_PRIVATE_KEY` to `review.yml`. When it doesn't, it adds them to the local caller (`.github/workflows/review-pr.yml` unless the default branch's caller is another file) for you to commit and merge.
- **Org variable** and **Org secret:** they reach the repo. They fail only when the org shares them with selected repos that exclude this one, with the org settings link.
- **Policy:** `.github/yoke-risk.yml` is on the default branch and parses, or its parse error. A local `.github/yoke-risk.yml` that doesn't parse fails it too, so a draft is checked before it's merged.
- **Merge mode:** in `merge` mode, read from the local `.github/yoke-risk.yml` if there is one, otherwise the default branch's, **Allow auto-merge** is on and the default branch requires 1 approval and dismisses stale approvals on push, through classic branch protection or rulesets. It turns on what's missing, adding a `yoke risk` ruleset for the approval rule, and says what it changed; without the rights to, it says what a repo admin must do.
- **App installed:** the App token step of the latest review run that tried it succeeded, read from the job log since the step continues on error; a failed step gives the App's install link.
- **Working:** the latest `## Risk` section on the 20 most recently updated PRs was posted with the App. Until one is, open or push to a PR once the setup is merged.

To set it up by hand, create a GitHub App named `yoke-review`, with no webhook and these permissions: repository Contents read and write, Pull requests read and write, Metadata read; organization Members read. Install it only on the repos that opt in, then pass its client ID and private key to the caller:

```yaml
    with:
      review-app-client-id: ${{ vars.YOKE_REVIEW_APP_CLIENT_ID }}
    secrets:
      YOKE_REVIEW_APP_PRIVATE_KEY: ${{ secrets.YOKE_REVIEW_APP_PRIVATE_KEY }}
```

Don't reuse the `yoke-release` App: it bypasses yoke's `main` ruleset. Without the App token the `## Risk` section records the decision and says nothing was approved.

For `merge` mode, turn on **Allow auto-merge** in the repo's general settings, and on the default branch require the `review / gate` check and an approving review, and dismiss stale approvals when new commits are pushed. Auto-merge stays on across pushes, so these keep a push from merging on an earlier approval before it is rated again, even if the risk step fails.

#### Sampled human check

After approving a PR, the App picks it at random with the chance `sample.rate`, labels it `sample.label` and requests a review from `sample.reviewers` (leaving out the PR's author), so a human can approve or request changes before or after it merges. Sampling doesn't hold the PR back: in `merge` mode auto-merge is still enabled. A PR that already has the label isn't sampled again. Each step is listed under **Actions** in the `## Risk` section, including a label or review request GitHub refused.

`yoke review risk-report [owner/repo...]` lists, for each repo (default: the current one), the risk decision on each of its 30 most recently updated PRs (`--limit`, up to 100), and for each sampled PR the last human approval or changes request, so you can see how often a person disagreed with an automated approval and tune the policy. It reads the decisions from the `## Risk` sections the review posted, and the label from each repo's policy.

```text
o/r: 4 of the 30 most recently updated PRs have a risk decision; 3 auto-approved, 2 sampled (1 approved, 1 changes requested, 0 without a verdict)
  #41 merged: low risk, approved by yoke-review · sampled: approved by alice
  #40 open: low risk, approved by yoke-review · sampled: changes requested by bob
  #39 open: medium risk, needs a human
  #38 merged: low risk, approved by yoke-review
```

### Foundry with Entra auth

For a Foundry resource that rejects API keys, sign in as an Entra app with the job's GitHub OIDC token:

```sh
yoke review ci --provider foundry --azure-client-id <id> --azure-tenant-id <id> [--environment <name>]
```

`yoke review ci` then prints the federated credential to add to the app. The app also needs the Cognitive Services User role on the Foundry resource.
