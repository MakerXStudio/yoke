import type { Skill } from '../../skill'

export const reviewCiRiskSkill: Skill = {
  name: 'review-ci-risk',
  description:
    "Set up and confirm this repo's experimental risk-based review: draft its policy, require the review gate and raise the setup PR.",
  disableModelInvocation: true,
  userLevel: true,
  body: `
Run \`yoke review ci-risk\` and relay its checklist. It changes what it can itself: it requires the gate, adds the App lines to the local caller workflow and, in \`merge\` mode, turns on Allow auto-merge and adds the approval ruleset. Relay each change it made.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\`.

## Policy

When the Policy line fails because \`.github/yoke-risk.yml\` is missing, draft one; when it shows a parse error, fix the file. Run \`yoke review ci-risk --example-policy\` for the example policy and its comments.

Read the repo's layout (\`git ls-files\`, its top-level directories and package manifests) before drafting, and tailor these keys to it:

- \`mode\`: \`approve\`, unless the user wants low-risk PRs to merge themselves (\`merge\`).
- \`lowRisk\`: globs for files no one needs to eyeball in this repo, such as docs, naming paths that exist here rather than the example's.
- \`alwaysHuman\`: globs for files that always need a human here, such as auth, payments, migrations, infrastructure, deployment and secrets handling, naming paths that exist here.

Keep the example's other keys and comments. Show the draft with a one-line reason for each glob and get the user's sign-off before writing it; fold in their changes and ask again until they approve.

Write the approved policy to \`.github/yoke-risk.yml\` and run \`yoke review ci-risk\` again; its Policy line shows the local file's parse error if it has one.

## Setup PR

Once the policy is approved, branch off the default branch if you're on it, commit \`.github/yoke-risk.yml\` and the caller workflow it edited, push, and raise the PR as \`yoke pr raise --help\` says.

## What's left

For each requirement that still fails, say what is missing and who can fix it, with the link it prints: an org owner for the App install or the org variable and secret's repo access, a repo admin for a setting it couldn't change. Never ask anyone to set the App variable or secret on the repo. Don't change the GitHub settings it reports any other way, and don't list steps you did yourself.

Policy, Workflow and Working pass only once the setup PR is merged and a PR is reviewed on it: say so, and that running \`/review-ci-risk\` again then confirms the setup. It exits non-zero until every requirement passes.
`,
}
