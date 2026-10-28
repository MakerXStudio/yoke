import type { Skill } from '../../skill'

export const prSkill: Skill = {
  name: 'pr',
  description: 'Raise or rewrite a PR with a concise What/Why/(How) description.',
  body: `
Run \`yoke pr raise --help\` and follow it exactly. Do not use \`gh pr create\`.

If \`yoke\` is not found, run \`npm i -g @makerx/yoke\` and retry.
`,
}
