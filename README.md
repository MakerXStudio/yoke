# yoke

Claude Code skills for MakerX AI-assisted delivery, and the CLI they call.

## Principles

- **Slash-invoked.** Skills may be called directly with slash commands.
- **Overridable.** A skill of your own with the same name wins.
- **Lean.** Few skills, short prompts; the CLI enforces the rules.

## Usage

```bash
npm i -D @makerx/yoke   # at the repo root
npx yoke sync           # then commit .claude/skills
```

## Skills

- `/pr` raises a PR with a short What/Why/(How) description.

## License

[MIT](LICENSE)
