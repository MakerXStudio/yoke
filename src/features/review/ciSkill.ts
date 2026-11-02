import type { Skill } from '../../skill'

export const reviewCiSkill: Skill = {
  name: 'review-ci',
  description: "Add yoke's adversarial PR review workflow to this repo and set the variable and secret it needs.",
  disableModelInvocation: true,
  userLevel: true,
  body: `
Run \`yoke review-ci $ARGUMENTS\`. If it reports that a model is required, run \`yoke models\` to list what the provider serves, ask the user which model each reviewer should run, and rerun with \`--reviewer-1-model\` and \`--reviewer-2-model\`. If it reports the workflow already exists and differs, show the user the difference and ask before rerunning with \`--force\`.

With \`--provider foundry\`, if the Foundry resource has local (API key) auth disabled or the user prefers Entra, rerun with \`--azure-client-id\` and \`--azure-tenant-id\` of the Entra app the job signs in as, plus \`--environment\` if the job should run in a GitHub environment. Ask the user for these values; don't guess them.

Then set the variable and secret it printed. Run \`gh variable list\` and \`gh secret list\` first; if one is missing, ask whether it is already set at the org level before setting it on the repo.
- \`REVIEW_CI_BASE_URL\` is a variable, not a secret: confirm the URL with the user and run the printed \`gh variable set\` command.
- \`REVIEW_CI_API_KEY\` must never enter this conversation: ask the user to run \`gh secret set REVIEW_CI_API_KEY\` in their own terminal, outside this session, and paste the key at its prompt. With Entra auth there is no API key to set.

With Entra auth, show the user the federated credential it printed (issuer, audience, subject) and the \`az ad app federated-credential create\` command, and ask whether to run it or whether they will add the credential in the Azure portal. The app also needs the Cognitive Services User role on the Foundry resource, and the environment, if given, must exist on the repo.

Finish by running \`gh variable list\` and \`gh secret list\` and telling the user to commit and push the workflow file. Show them the printed \`gh api\` ruleset command requiring \`review / gate\`, and tell them to run it only once the workflow is merged to the default branch; don't run it before then.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\` and retry.
`,
}
