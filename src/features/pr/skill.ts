import type { Skill } from '../../skill'

export const prSkill: Skill = {
  name: 'pr',
  description: 'Raise a PR with a concise What/Why/(How) description',
  body: `
Run \`yoke pr raise --help\` and follow it exactly. Do not use \`gh pr create\`.

If \`yoke\` is not on PATH, stop and tell the user to run \`npm i -g @makerx/yoke\`.
`,
}
