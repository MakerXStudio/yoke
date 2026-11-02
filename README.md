# yoke

Claude Code skills for MakerX AI-assisted delivery, and the CLI they call.

## Principles

- **Slash-invoked.** Skills may be called directly with slash commands.
- **Overridable.** A skill of your own with the same name wins. yoke's descriptions start with `[yoke]` so you can tell them apart.
- **Lean.** Few skills, short prompts; the CLI enforces the rules.

## Usage

```bash
npm i -g @makerx/yoke

# then either
yoke sync          # this repo's .claude/skills
# or
yoke sync --user   # ~/.claude/skills
```

## Skills

- `/pr` raises a PR with a short What/Why/(How) description.
- `/review [number]` reviews a PR with Claude and Codex, combines their findings and offers to post them. [Configure](src/features/review/README.md#settings).
- `/review-ci` makes CI review each PR, adding a workflow or switching the repo's existing LLM review workflow over, and helps set its variable and secret. [Details](src/features/review/README.md#ci).
- `/review-ci-gate` blocks merging until the CI review passes, once its workflow is merged. [Details](src/features/review/README.md#merge-gate).

## CLI

```bash
yoke sync [--user] [--force]  # write yoke's skills
yoke review [number]          # review a PR (used by /review)
yoke review-ci                # add the CI review workflow (used by /review-ci)
yoke review-ci-gate           # require the review / gate check on the default branch (used by /review-ci-gate)
yoke review-gate <result>     # block merging until the PR's latest review succeeds (used by review.yml)
yoke models                   # list each provider's models
```

## Configuration

```bash
yoke config                            # list settings and their values
yoke config set --user <key> <value>   # save to ~/.config/yoke/config.json
```

A setting can also be passed per run as a flag or env var: `yoke review --reviewer-2-model gpt-5` or `YOKE_REVIEW_REVIEWER_2_MODEL=gpt-5`. API keys are env or config only.
