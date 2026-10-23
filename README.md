# yoke

Claude Code skills for MakerX AI-assisted delivery, and the CLI they call.

## Principles

- **User-invoked.** Skills run only when you type their slash command.
- **Overridable.** A skill of your own with the same name wins.
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

## License

[MIT](LICENSE)
