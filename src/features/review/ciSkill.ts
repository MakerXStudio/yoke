import type { Skill } from '../../skill'

export const reviewCiSkill: Skill = {
  name: 'review-ci',
  description:
    "Add yoke's adversarial PR review workflow to this repo, or switch its existing LLM review workflow to it, and set the variable and secret it needs.",
  disableModelInvocation: true,
  userLevel: true,
  body: `
Read \`.github/workflows/\`, recent review runs (\`gh run list\`, \`gh run view --log\`) and \`yoke config list\` before asking anything. Only ask what they don't answer, in plain words about the repo, not flags.

## Workflow

A workflow is an LLM review if it has a model review PRs, whatever tool it uses.

- **None:** run \`yoke review-ci $ARGUMENTS\`.
- **One, not yoke's:** run \`yoke review-ci $ARGUMENTS --print\` with its provider and models, then edit that file in place to run yoke's review. Keep its name, triggers, provider, models, base URL, variable and secret names.
- **Already yoke's** (calls MakerXStudio/yoke's \`review.yml\`, or \`./.github/workflows/review.yml\` in yoke itself): compare with \`--print\` and add only what is missing.

Never ask whether to overwrite a workflow. If \`review-pr.yml\` exists and differs, edit it in place.

The \`review / gate\` merge gate needs the \`synchronize\` trigger, the \`pull_request_target\` \`labeled\` and \`synchronize\` triggers, and the \`actions: write\` and \`statuses: write\` permissions from \`--print\`; add them to an edited workflow if missing.

If no workflow or setting names the models, ask which model each reviewer runs. For LiteLLM, offer \`yoke models\`. For Foundry, ask for deployment names.

For Foundry with Entra, reuse the client and tenant IDs from the existing workflow; ask only if none is there.

## Variable and secret

Never ask whether they are set for the organisation, and don't query org settings.

- \`REVIEW_CI_BASE_URL\` not in \`gh variable list\`: set it on the repo with the base URL from the workflow or the printed command.
- \`REVIEW_CI_API_KEY\` not in \`gh secret list\`: tell the user to run \`gh secret set REVIEW_CI_API_KEY\` in their own terminal, and to skip it if the secret is already set for the organisation. Never take the key in this conversation.

With Entra, check \`az ad app federated-credential list --id <client-id>\` and show the printed create command if the credential is missing.

Finish with what changed and what's left: commit and push the workflow, then, once it is merged to the default branch, run \`/review-ci-gate\` to require \`review / gate\` before merging.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\`.
`,
}
