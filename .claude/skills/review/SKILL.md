---
name: review
description: Adversarially review a PR with Claude and Codex, then combine their findings.
disable-model-invocation: true
metadata:
  owner: "@makerx/yoke"
---

Run `yoke review $ARGUMENTS` in the background and wait for it to finish; two reviewers and a synthesis pass take several minutes. Then relay the findings it printed. Do not add findings of your own or re-review the code.

If `$ARGUMENTS` does not already include `--post`, ask whether to post the findings to the PR. If the user agrees, run `yoke review $ARGUMENTS --post`; it posts the review it just saved rather than reviewing again, as one GitHub review with an inline comment per finding on a diff line, and skips findings already raised on the PR. Relay what it reports.

If `yoke` is not found, run `npm i -g @makerx/yoke` and retry.
