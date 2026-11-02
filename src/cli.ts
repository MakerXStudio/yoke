import { relative } from 'node:path'

import { Command } from 'commander'

import packageJson from '../package.json' with { type: 'json' }
import { addSettingOptions, flagSettings, settingsHelp } from './cliSettings'
import { listSettings, resolveSettings, settingKeys } from './features/config/settings'
import { ConfigError, readUserConfig, setSetting, userConfigPath } from './features/config/userConfig'
import { raiseGuide } from './features/pr/guide'
import { PrValidationError, raisePr } from './features/pr/raise'
import { listModels } from './features/review/models'
import { ReviewError } from './features/review/pr'
import { reviewPr } from './features/review/review'
import { lineUi, spinnerUi } from './features/review/status'
import { skillsRoot, syncSkills } from './features/sync/sync'
import { detectInstall, installDir } from './features/update/install'
import { syncTargets } from './features/update/targets'
import { updateYoke } from './features/update/update'
import { addReviewCiCommands } from './reviewCiCommands'

const { version } = packageJson

const program = new Command('yoke').description('Lean Claude Code skills and the CLI they call.').version(version)

program
  .command('sync')
  .description("Write yoke's skills into this repo's .claude/skills, or ~/.claude/skills with --user")
  .option('--user', 'write to ~/.claude/skills instead, for every repo')
  .option('--force', "overwrite same-named skills that yoke didn't write")
  .action((options: { user?: boolean; force?: boolean }) => {
    const user = options.user ?? false
    const cwd = process.cwd()
    const display = (path: string) => (path.startsWith(cwd) ? relative(cwd, path) : path)
    const { written, skipped } = syncSkills(skillsRoot(user), skillsRoot(true), options.force ?? false)
    for (const file of written) console.log(`wrote ${display(file)}`)
    for (const dir of skipped) console.log(`skipped ${display(dir)} (not yoke's skill; rerun with --force to overwrite it)`)
  })

program
  .command('update')
  .description('Update yoke to the latest version, then re-sync its skills wherever they were synced before')
  .action(() => {
    const dir = installDir()
    process.exitCode = updateYoke({
      dir,
      install: detectInstall(dir),
      targets: () => syncTargets(),
      log: console.log,
      error: console.error,
    })
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

addSettingOptions(
  program
    .command('review')
    .description("Review the current branch's PR, or PR <number>, with Claude and Codex in parallel, then combine their findings")
    .argument('[number]', 'PR number; reviewed without checking it out')
    .option('--post', 'post the findings to the PR as one review, reusing the saved review of the PR head when there is one')
    .option('--force', "discard this PR head's cached reviews and run every pass again")
    .option('--verbose', "print every step and each reviewer's tool calls as log lines instead of live spinners")
    .option('--head <sha>', "refuse to review unless the PR's head is this commit; empty skips the check"),
  settingKeys,
)
  .addHelpText('after', settingsHelp)
  .action(
    async (
      number: string | undefined,
      options: { post?: boolean; force?: boolean; verbose?: boolean; head?: string } & Record<string, unknown>,
    ) => {
      const verbose = options.verbose ?? false
      const ui = process.stderr.isTTY && !verbose ? spinnerUi(process.stderr) : lineUi(console.error, { activity: verbose })
      try {
        const settings = resolveSettings(flagSettings(options, settingKeys), process.env, readUserConfig(userConfigPath()))
        const run = { post: options.post ?? false, force: options.force ?? false, head: options.head }
        await reviewPr(number, settings, run, { out: console.log, ui })
      } catch (error) {
        if (!(error instanceof ReviewError || error instanceof ConfigError)) throw error
        console.error(error.message)
        process.exitCode = 1
      } finally {
        ui.stop()
      }
    },
  )

addReviewCiCommands(program)

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
