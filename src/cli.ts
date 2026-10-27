import { relative } from 'node:path'

import { Command } from 'commander'

import packageJson from '../package.json' with { type: 'json' }
import {
  type FlagSettings,
  listSettings,
  resolveSettings,
  settingDescription,
  settingFlag,
  type SettingKey,
  settingKeys,
} from './features/config/settings'
import { ConfigError, readUserConfig, setSetting, userConfigPath } from './features/config/userConfig'
import { raiseGuide } from './features/pr/guide'
import { PrValidationError, raisePr } from './features/pr/raise'
import { listModels } from './features/review/models'
import { ReviewError } from './features/review/pr'
import { reviewPr } from './features/review/review'
import { skillsRoot, syncSkills } from './features/sync/sync'

const { version } = packageJson

const program = new Command('yoke').description('Lean Claude Code skills and the CLI they call.').version(version)

program
  .command('sync')
  .description("Write yoke's skills into this repo's .claude/skills, or ~/.claude/skills with --user")
  .option('--user', 'write to ~/.claude/skills instead, for every repo')
  .action((options: { user?: boolean }) => {
    const user = options.user ?? false
    const display = (path: string) => (user ? path : relative(process.cwd(), path))
    const { written, skipped } = syncSkills(skillsRoot(user))
    for (const file of written) console.log(`wrote ${display(file)}`)
    for (const dir of skipped) console.log(`skipped ${display(dir)} (your own skill; delete it to take yoke's)`)
  })

const pr = program.command('pr').description('Pull request commands')

pr.command('raise')
  .description('Validate a PR title and body, then create the PR with gh')
  .requiredOption('--title <title>', 'single-line PR title')
  .requiredOption('--body <body>', 'PR body with ## What, ## Why and optionally ## How')
  .option('--base <branch>', 'base branch (defaults to the repo default)')
  .option('--no-draft', 'create a ready-for-review PR instead of a draft')
  .addHelpText('after', raiseGuide)
  .action((options: { title: string; body: string; base?: string; draft: boolean }) => {
    try {
      console.log(raisePr(options))
    } catch (error) {
      if (!(error instanceof PrValidationError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

const providerKeys = settingKeys.filter((key) => !key.startsWith('review.'))

function addSettingOptions(command: Command, keys: readonly SettingKey[]): Command {
  for (const key of keys) {
    const flag = settingFlag(key)
    if (flag) command.option(`${flag} <value>`, settingDescription(key))
  }
  return command
}

function optionName(flag: string): string {
  return flag.slice(2).replace(/-(.)/g, (_, next: string) => next.toUpperCase())
}

function flagSettings(options: Record<string, unknown>, keys: readonly SettingKey[]): FlagSettings {
  const flags: FlagSettings = {}
  for (const key of keys) {
    const flag = settingFlag(key)
    const value = flag && options[optionName(flag)]
    if (typeof value === 'string') flags[key] = value
  }
  return flags
}

const settingsHelp =
  '\nEach setting falls back to its YOKE_* env var, then `yoke config set --user`; API keys come from env or config only. Run `yoke config` to see them all.'

addSettingOptions(
  program
    .command('review')
    .description("Review the current branch's PR, or PR <number>, with Claude and Codex in parallel, then combine their findings")
    .argument('[number]', 'PR number; reviewed without checking it out')
    .option('--post', 'post the findings to the PR as one review, reusing the saved review of the PR head when there is one'),
  settingKeys,
)
  .addHelpText('after', settingsHelp)
  .action(async (number: string | undefined, options: { post?: boolean } & Record<string, unknown>) => {
    try {
      const settings = resolveSettings(flagSettings(options, settingKeys), process.env, readUserConfig(userConfigPath()))
      await reviewPr(number, settings, { post: options.post ?? false }, { out: console.log, log: console.error })
    } catch (error) {
      if (!(error instanceof ReviewError || error instanceof ConfigError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

addSettingOptions(
  program.command('models').description('List the models each configured provider serves, for review.*.provider and review.*.model'),
  providerKeys,
)
  .addHelpText('after', settingsHelp)
  .action(async (options: Record<string, unknown>) => {
    try {
      const models = await listModels(resolveSettings(flagSettings(options, providerKeys), process.env, readUserConfig(userConfigPath())))
      console.log(models.join('\n'))
    } catch (error) {
      if (!(error instanceof ReviewError || error instanceof ConfigError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

const config = program.command('config').description('yoke settings')

config
  .command('list', { isDefault: true })
  .description('List every setting and its value from YOKE_* env vars, then the user-level yoke config; secrets are masked')
  .action(() => {
    try {
      console.log(listSettings(resolveSettings({}, process.env, readUserConfig(userConfigPath())), process.stdout.columns))
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

config
  .command('set')
  .description(`Write a setting to the user-level yoke config (${settingKeys.join(', ')})`)
  .argument('<key>', 'setting key')
  .argument('<value>', 'setting value')
  .option('--user', 'write to the user-level config; required, since repo-level config is not supported')
  .action((key: string, value: string, options: { user?: boolean }) => {
    try {
      console.log(setSetting(key, value, options.user ?? false, userConfigPath()))
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

await program.parseAsync()
