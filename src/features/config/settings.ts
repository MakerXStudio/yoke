export const settingKeys = [
  'modelProvider.kind',
  'modelProvider.baseUrl',
  'modelProvider.apiKey',
  'review.reviewer1',
  'review.reviewer2',
  'review.synthesis',
] as const

export type SettingKey = (typeof settingKeys)[number]

export type Settings = Partial<Record<SettingKey, string>>

export type FlagSettings = Partial<Record<Exclude<SettingKey, 'modelProvider.apiKey'>, string>>

const sources: Record<SettingKey, { env: string; flag?: string }> = {
  'modelProvider.kind': { env: 'YOKE_MODEL_PROVIDER_KIND', flag: '--provider' },
  'modelProvider.baseUrl': { env: 'YOKE_MODEL_PROVIDER_BASE_URL', flag: '--base-url' },
  'modelProvider.apiKey': { env: 'YOKE_MODEL_PROVIDER_API_KEY' },
  'review.reviewer1': { env: 'YOKE_REVIEW_REVIEWER_1', flag: '--reviewer-1' },
  'review.reviewer2': { env: 'YOKE_REVIEW_REVIEWER_2', flag: '--reviewer-2' },
  'review.synthesis': { env: 'YOKE_REVIEW_SYNTHESIS', flag: '--synthesis' },
}

export function isSettingKey(key: string): key is SettingKey {
  return (settingKeys as readonly string[]).includes(key)
}

export function resolveSettings(flags: FlagSettings, env: NodeJS.ProcessEnv, config: Settings): Settings {
  const resolved: Settings = {}
  for (const key of settingKeys) {
    const flag = key === 'modelProvider.apiKey' ? undefined : flags[key]
    const value = [flag, env[sources[key].env], config[key]].map((candidate) => candidate?.trim()).find(Boolean)
    if (value) resolved[key] = value
  }
  return resolved
}

export function howToSet(key: SettingKey, placeholder = '<value>'): string {
  const { env, flag } = sources[key]
  const ways = [...(flag ? [`pass ${flag}`] : []), `set ${env}`, `run \`yoke config set --user ${key} ${placeholder}\``]
  return `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}`
}
