# yoke

Claude Code skills for MakerX AI-assisted delivery, and the CLI they call.

## Principles

- **Slash-invoked.** Skills may be called directly with slash commands.
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
- `/review [number]` reviews the current branch's PR, or PR `<number>`, with Claude and Codex in parallel through your own `claude` and `codex` CLIs, then combines, de-duplicates and ranks their findings. Only you can invoke it. It then offers to post them: `yoke review --post` submits one GitHub review with an inline comment per finding on a diff line and the rest in the review body, skipping findings already raised on the PR. It posts the review saved for the PR's head commit when there is one (under `~/.cache/yoke/reviews`), so what's posted is what you saw.

### Running review slots through a model provider

Each of `review.reviewer1`, `review.reviewer2` and `review.synthesis` is `<claude|codex>[:<model>][@provider]`: the CLI to run, an optional model, and `@provider` to run it through a LiteLLM proxy or Azure AI Foundry instead of your own login. `@provider` needs a model. Unset, the reviewers run `claude` and `codex` on your own login. Run `yoke config` to see every setting, its value and what it does.

```sh
yoke config set --user modelProvider.kind litellm            # or foundry
yoke config set --user modelProvider.baseUrl https://llm.example.com
yoke config set --user modelProvider.apiKey <key>
yoke config set --user review.reviewer2 codex:gpt-5-codex@provider
```

Settings live in `~/.config/yoke/config.json` (or `$XDG_CONFIG_HOME/yoke/config.json`); repo-level config is not supported. Each one can be overridden per run with a flag (`--provider`, `--base-url`, `--reviewer-1`, `--reviewer-2`, `--synthesis`) or an env var (`YOKE_MODEL_PROVIDER_KIND`, `YOKE_MODEL_PROVIDER_BASE_URL`, `YOKE_MODEL_PROVIDER_API_KEY`, `YOKE_REVIEW_REVIEWER_1`, `YOKE_REVIEW_REVIEWER_2`, `YOKE_REVIEW_SYNTHESIS`). The API key has no flag.

## License

[MIT](LICENSE)
