import { z } from 'zod'

const slotExamples = [
  'review.* values, for example:',
  '  claude                  claude on your own login',
  '  claude:opus             claude on your own login, using opus',
  '  codex:gpt-5@provider    codex through the model provider, using gpt-5',
]

const settingsSchema = z.object({
  'modelProvider.kind': z.string().optional().meta({ description: 'Model provider that @provider slots run through: litellm or foundry' }),
  'modelProvider.baseUrl': z
    .string()
    .optional()
    .meta({ description: 'Model provider URL: the LiteLLM proxy root, or https://<resource>.services.ai.azure.com for Foundry' }),
  'modelProvider.apiKey': z
    .string()
    .optional()
    .meta({ description: 'Model provider API key; set YOKE_MODEL_PROVIDER_API_KEY or run `yoke config set --user`', secret: true }),
  'review.reviewer1': z.string().optional().meta({ description: 'First reviewer. Default: claude on your own login' }),
  'review.reviewer2': z.string().optional().meta({ description: 'Second reviewer. Default: codex on your own login' }),
  'review.synthesis': z
    .string()
    .optional()
    .meta({ description: "Combines and ranks both reviews. Default: the first reviewer's CLI on your own login" }),
})

export const settingKeys = settingsSchema.keyof().options

export type SettingKey = (typeof settingKeys)[number]

export type Settings = z.infer<typeof settingsSchema>

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

function displayValue(key: SettingKey, value: string | undefined): string {
  if (!value) return '<not set>'
  return settingsSchema.shape[key].meta()?.secret === true ? '****' : value
}

const gap = '  '

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  return line ? [...lines, line] : lines
}

export function listSettings(settings: Settings, columns = Infinity): string {
  const rows = settingKeys.map((key) => ({
    key,
    value: displayValue(key, settings[key]),
    description: settingsSchema.shape[key].meta()?.description ?? '',
  }))
  const keyWidth = Math.max(...rows.map(({ key }) => key.length))
  const indent = ' '.repeat(keyWidth + gap.length)
  const blocks = rows.map(({ key, value, description }) =>
    [`${key.padEnd(keyWidth)}${gap}${value}`, ...wrap(description, columns - indent.length).map((line) => indent + line)].join('\n'),
  )
  return [...blocks, slotExamples.join('\n')].join('\n\n')
}

export function howToSet(key: SettingKey, placeholder = '<value>'): string {
  const { env, flag } = sources[key]
  const ways = [...(flag ? [`pass ${flag}`] : []), `set ${env}`, `run \`yoke config set --user ${key} ${placeholder}\``]
  return `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}`
}
