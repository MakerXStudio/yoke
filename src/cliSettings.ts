import type { Command } from 'commander'

import { type FlagSettings, settingDescription, settingFlag, type SettingKey } from './features/config/settings'

export function addSettingOptions(command: Command, keys: readonly SettingKey[]): Command {
  for (const key of keys) {
    const flag = settingFlag(key)
    if (flag) command.option(`${flag} <value>`, settingDescription(key))
  }
  return command
}

function optionName(flag: string): string {
  return flag.slice(2).replace(/-(.)/g, (_, next: string) => next.toUpperCase())
}

export function flagSettings(options: Record<string, unknown>, keys: readonly SettingKey[]): FlagSettings {
  const flags: FlagSettings = {}
  for (const key of keys) {
    const flag = settingFlag(key)
    const value = flag && options[optionName(flag)]
    if (typeof value === 'string') flags[key] = value
  }
  return flags
}

export const settingsHelp =
  '\nEach setting falls back to its YOKE_* env var, then `yoke config set --user`; API keys come from env or config only. Run `yoke config` to see them all.'
