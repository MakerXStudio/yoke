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
- `/review [number]` reviews the current branch's PR, or PR `<number>`, with Claude and Codex in parallel through your own `claude` and `codex` CLIs, then combines, de-duplicates and ranks their findings. Only you can invoke it. It then offers to post them: `yoke review --post` submits one GitHub review with an inline comment per finding on a diff line and the rest in the review body, skipping findings already raised on the PR. Each run is kept per PR head commit under `~/.cache/yoke/reviews/<pr>-<sha>/`: re-running reuses any reviewer or synthesis that already finished, `--post` posts the saved review so what's posted is what you saw, and `--force` starts over.

### Running review slots through a model provider

`review.reviewer1`, `review.reviewer2` and `review.synthesis` each have a `harness` (`claude` or `codex`), a `provider` (`litellm` or `foundry`) and a `model`. Unset, the reviewers run `claude` and `codex` on your own login. Setting a provider runs that slot through it, and needs a model; `yoke models` lists each configured provider's models. Run `yoke config` to see every setting and its value.

```sh
yoke config set --user litellm.baseUrl https://llm.example.com   # or foundry.baseUrl https://<resource>.services.ai.azure.com
yoke config set --user litellm.apiKey <key>
yoke models
yoke config set --user review.reviewer2.provider litellm
yoke config set --user review.reviewer2.model azure-us/gpt-5.1-codex
```

Settings live in `~/.config/yoke/config.json` (or `$XDG_CONFIG_HOME/yoke/config.json`); repo-level config is not supported. Each one can be overridden per run with a flag named after it (`review.reviewer2.model` is `--reviewer-2-model`, `litellm.baseUrl` is `--litellm-base-url`) or an env var (`YOKE_REVIEW_REVIEWER_2_MODEL`, `YOKE_LITELLM_BASE_URL`). API keys have no flag.

## License

[MIT](LICENSE)
