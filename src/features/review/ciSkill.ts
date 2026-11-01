import type { Skill } from '../../skill'

export const reviewCiSkill: Skill = {
  name: 'review-ci',
  description: "Add yoke's adversarial PR review workflow to this repo and set the secrets it needs.",
  disableModelInvocation: true,
  body: `
Run \`yoke review-ci $ARGUMENTS\`. If it reports that a model is required, run \`yoke models\` to list what the provider serves, ask the user which model each reviewer should run, and rerun with \`--reviewer-1-model\` and \`--reviewer-2-model\`. If it reports the workflow already exists and differs, show the user the difference and ask before rerunning with \`--force\`.

Then set the two secrets it printed. Run \`gh secret list\` first; if either secret is missing, ask whether it is already set at the org level before setting it on the repo.
- \`REVIEW_CI_BASE_URL\` is not secret: confirm the URL with the user and run the printed command.
- \`REVIEW_CI_API_KEY\` must never enter this conversation: ask the user to run \`! gh secret set REVIEW_CI_API_KEY\` themselves and paste the key at its prompt.

Finish by running \`gh secret list\` and telling the user to commit and push the workflow file.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\` and retry.
`,
}
