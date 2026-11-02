import type { Command } from 'commander'

import { settingDescription, settingFlag, type SettingKey } from './settings'

export function addSettingOptions(command: Command, keys: readonly SettingKey[]): Command {
  for (const key of keys) {
    const flag = settingFlag(key)
    if (flag) command.option(`${flag} <value>`, settingDescription(key))
  }
  return command
}
