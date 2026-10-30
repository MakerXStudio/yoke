# review

Two reviewers review a PR independently, then a third pass combines and ranks their findings.

## Parameters

| Parameter | Description |
|---|---|
| `[number]` | PR to review. Default: the current branch's PR. |
| `--post` | Post the findings as one GitHub review, reusing the saved review when there is one. |
| `--force` | Discard the cached reviews and run every pass again. |
| `--verbose` | Print each step and reviewer tool call as log lines instead of spinners. |

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
