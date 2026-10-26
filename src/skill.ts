export const ownerMarker = 'owner: "@makerx/yoke"'

export type Skill = { name: string; description: string; body: string; modelInvocable?: boolean }

export function renderSkill({ name, description, body, modelInvocable }: Skill): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(modelInvocable ? [] : ['disable-model-invocation: true']),
    'metadata:',
    `  ${ownerMarker}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}
