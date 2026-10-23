# yoke

Lean Claude Code skills for MakerX AI-assisted delivery, plus the CLI they call.

yoke ships a small set of skills (starting with `/pr`) and a `yoke` CLI that does the deterministic part of each one: the skill drafts, the CLI validates and acts. `yoke sync` writes the skills into a repo or your home directory so Claude Code picks them up.

## Principles

- **User-invoked.** Every skill sets `disable-model-invocation: true`. It runs only when you type its slash command; Claude never triggers it on its own.
- **Overridable.** Your own skill of the same name wins. yoke never overwrites a skill it did not write.
- **Lean.** Few skills, short prompts, rules enforced by the CLI rather than by long instructions. A skill earns its place by being a baseline must-have.

## Install

Requires Node 24 or later. For `/pr`, the [GitHub CLI](https://cli.github.com/) must be installed and authenticated.

Add it to a repo so the whole team gets the same version:

```bash
npm install --save-dev @makerx/yoke
```

Or run it without installing:

```bash
npx @makerx/yoke sync
```

## Sync

```bash
npx @makerx/yoke sync          # writes .claude/skills/<skill>/ in the current repo
npx @makerx/yoke sync --user   # writes ~/.claude/skills/<skill>/ for every repo
```

Commit the repo-level output so everyone on the project gets the skills. Re-run `sync` after upgrading yoke; it replaces only the files yoke wrote and leaves your other skills, and any extra files in a yoke skill's folder, alone.

yoke marks the skills it writes with `owner: "@makerx/yoke"` under `metadata` in the frontmatter. A skill folder whose `SKILL.md` lacks that marker is yours, and `sync` skips it.

## Skills

| Skill | What it does |
|---|---|
| `/pr` | Drafts a PR title and a short What/Why/(How) body, asks for approval, pushes, and creates a draft PR with `yoke pr raise`. |

`yoke pr raise --title <title> --body <body>` rejects a title over one line or 70 characters, and a body that is missing `## What` or `## Why`, has any other section, exceeds the per-section or 600-character total cap, or lists changes file by file. It names each rule that failed. On success it runs `gh pr create` (as a draft unless `--no-draft`) and prints the PR URL.

## Overriding a skill

Claude Code resolves a skill name from personal (`~/.claude/skills`) before project (`.claude/skills`), so the simplest override is a personal skill of the same name:

```bash
mkdir -p ~/.claude/skills/pr
cp .claude/skills/pr/SKILL.md ~/.claude/skills/pr/SKILL.md
# edit it, and delete the `metadata` owner line so `yoke sync --user` leaves it alone
```

To override for one repo instead, edit `.claude/skills/<skill>/SKILL.md` in place and remove the owner line; `sync` will skip it from then on. Delete the folder and re-run `sync` to go back to yoke's version.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
