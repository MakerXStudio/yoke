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

## CLI

```bash
yoke sync [--user]      # write yoke's skills
yoke review [number]    # review a PR (used by /review)
yoke models             # list each provider's models
yoke config             # list or set settings
```

## Configuration

```bash
yoke config                            # list settings and their values
yoke config set --user <key> <value>   # save to ~/.config/yoke/config.json
```

A setting can also be passed per run as a flag or env var: `yoke review --reviewer-2-model gpt-5` or `YOKE_REVIEW_REVIEWER_2_MODEL=gpt-5`. API keys are env or config only.
