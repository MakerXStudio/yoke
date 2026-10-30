import { z } from 'zod'

function setting(description: string) {
  return z.string().optional().meta({ description })
}

function secret(description: string) {
  return z.string().optional().meta({ description, secret: true })
}

const providerHelp = 'litellm or foundry. Unset: your own login'
const modelHelp = 'See `yoke models`. Required with a provider'

const settingsSchema = z.object({
  'litellm.baseUrl': setting('LiteLLM proxy URL'),
  'litellm.apiKey': secret('LiteLLM API key. Env or --user config only'),
  'foundry.baseUrl': setting('https://<resource>.services.ai.azure.com'),
  'foundry.apiKey': secret('Foundry API key. Env or --user config only'),
  'review.reviewer1.harness': setting('claude or codex. Default: claude'),
  'review.reviewer1.provider': setting(providerHelp),
  'review.reviewer1.model': setting(modelHelp),
  'review.reviewer2.harness': setting('claude or codex. Default: codex'),
  'review.reviewer2.provider': setting(providerHelp),
  'review.reviewer2.model': setting(modelHelp),
  'review.synthesis.harness': setting('claude or codex. Default: reviewer1 harness'),
  'review.synthesis.provider': setting(providerHelp),
  'review.synthesis.model': setting(modelHelp),
})

export const settingKeys = settingsSchema.keyof().options

export type SettingKey = (typeof settingKeys)[number]

export type Settings = z.infer<typeof settingsSchema>

export type FlagSettings = Partial<Settings>

export function isSettingKey(key: string): key is SettingKey {
  return (settingKeys as readonly string[]).includes(key)
}

function isSecret(key: SettingKey): boolean {
  return settingsSchema.shape[key].meta()?.secret === true
}

export function settingDescription(key: SettingKey): string {
  return settingsSchema.shape[key].meta()?.description ?? ''
}

function snake(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, '$1_$2').replaceAll('.', '_')
}

export function settingEnv(key: SettingKey): string {
  return `YOKE_${snake(key).toUpperCase()}`
}

export function settingFlag(key: SettingKey): string | undefined {
  if (isSecret(key)) return undefined
  return `--${snake(key.replace(/^review\./, ''))
    .toLowerCase()
    .replaceAll('_', '-')}`
}

export function resolveSettings(flags: FlagSettings, env: NodeJS.ProcessEnv, config: Settings): Settings {
  const resolved: Settings = {}
  for (const key of settingKeys) {
    const flag = isSecret(key) ? undefined : flags[key]
    const value = [flag, env[settingEnv(key)], config[key]].map((candidate) => candidate?.trim()).find(Boolean)
    if (value) resolved[key] = value
  }
  return resolved
}

function displayValue(key: SettingKey, value: string | undefined): string {
  if (!value) return '<not set>'
  return isSecret(key) ? '****' : value
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
    description: settingDescription(key),
  }))
  const keyWidth = Math.max(...rows.map(({ key }) => key.length))
  const indent = ' '.repeat(keyWidth + gap.length)
  const blocks = rows.map(({ key, value, description }) =>
    [`${key.padEnd(keyWidth)}${gap}${value}`, ...wrap(description, columns - indent.length).map((line) => indent + line)].join('\n'),
  )
  return blocks.join('\n\n')
}

export function howToSet(key: SettingKey, placeholder = '<value>'): string {
  const flag = settingFlag(key)
  const ways = [...(flag ? [`pass ${flag}`] : []), `set ${settingEnv(key)}`, `run \`yoke config set --user ${key} ${placeholder}\``]
  return `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}`
}
