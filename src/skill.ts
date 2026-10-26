export const ownerMarker = 'owner: "@makerx/yoke"'

export type Skill = { name: string; description: string; body: string }

export function renderSkill({ name, description, body }: Skill): string {
  return ['---', `name: ${name}`, `description: ${description}`, 'metadata:', `  ${ownerMarker}`, '---', '', body.trim(), ''].join('\n')
}
