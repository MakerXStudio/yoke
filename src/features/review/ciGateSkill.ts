import type { Skill } from '../../skill'

export const reviewCiGateSkill: Skill = {
  name: 'review-ci-gate',
  description: "Block merging to this repo's default branch until yoke's CI review passes, once its review workflow is merged.",
  disableModelInvocation: true,
  userLevel: true,
  body: `
Run \`yoke review-ci-gate\` and relay its output.

If it fails, say what is missing and how to fix it, as it reports. Don't create the ruleset any other way.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\`.
`,
}
