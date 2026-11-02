import { type FlagSettings, settingFlag, type SettingKey } from './settings'

export function flagSettings(options: Record<string, unknown>, keys: readonly SettingKey[]): FlagSettings {
  const flags: FlagSettings = {}
  for (const key of keys) {
    const flag = settingFlag(key)
    const value = flag && options[optionName(flag)]
    if (typeof value === 'string') flags[key] = value
  }
  return flags
}

function optionName(flag: string): string {
  return flag.slice(2).replace(/-(.)/g, (_, next: string) => next.toUpperCase())
}
