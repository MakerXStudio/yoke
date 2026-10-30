export const ownerMarker = 'owner: "@makerx/yoke"'

export type Skill = { name: string; description: string; body: string; disableModelInvocation?: boolean }

export function renderSkill({ name, description, body, disableModelInvocation }: Skill): string {
  const invocation = disableModelInvocation ? ['disable-model-invocation: true'] : []
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(`[yoke] ${description}`)}`,
    ...invocation,
    'metadata:',
    `  ${ownerMarker}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}
