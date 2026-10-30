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
- `/review [number]` [reviews](src/features/review/README.md) a PR with Claude and Codex, combines their findings and offers to post them.

## Configuration

Settings live in `~/.config/yoke/config.json`. `yoke config` lists them with their values, and `yoke config set --user <key> <value>` sets one. Each can be overridden per run by a flag (`review.reviewer2.model` is `--reviewer-2-model`) or env var (`YOKE_REVIEW_REVIEWER_2_MODEL`); API keys have no flag. Set `litellm.baseUrl`/`litellm.apiKey` or `foundry.baseUrl`/`foundry.apiKey` to use a model provider, and `yoke models` lists its models.

## License

[MIT](LICENSE)
