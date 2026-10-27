import type { Skill } from '../../skill'

export const reviewSkill: Skill = {
  name: 'review',
  description: 'Adversarially review a PR with Claude and Codex, then combine their findings.',
  disableModelInvocation: true,
  body: `
Run \`yoke review $ARGUMENTS\` in the foreground, not as a background task, with the longest timeout your shell tool allows, so the user sees each reviewer's progress as it streams; two reviewers and a synthesis pass take several minutes. Then relay the findings it printed. Do not add findings of your own or re-review the code. Each reviewer's tool calls go to \`review.log\` in the review folder it prints, not to the output; read that log only if the user asks what a reviewer did.

If \`$ARGUMENTS\` does not already include \`--post\`, ask whether to post the findings to the PR. If the user agrees, run \`yoke review $ARGUMENTS --post\`; it posts the review it just saved rather than reviewing again, as one GitHub review with an inline comment per finding on a diff line, and skips findings already raised on the PR. Relay what it reports.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\` and retry.
`,
}
