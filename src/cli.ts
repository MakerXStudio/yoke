import { relative } from 'node:path'

import { Command } from 'commander'

import packageJson from '../package.json' with { type: 'json' }
import { resolveSettings, settingKeys } from './features/config/settings'
import { ConfigError, readUserConfig, setSetting, userConfigPath } from './features/config/userConfig'
import { raiseGuide } from './features/pr/guide'
import { PrValidationError, raisePr } from './features/pr/raise'
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

type ReviewOptions = { post?: boolean; provider?: string; baseUrl?: string; reviewer1?: string; reviewer2?: string; synthesis?: string }

program
  .command('review')
  .description("Review the current branch's PR, or PR <number>, with Claude and Codex in parallel, then combine their findings")
  .argument('[number]', 'PR number; reviewed without checking it out')
  .option('--post', 'post the findings to the PR as one review, reusing the saved review of the PR head when there is one')
  .option('--provider <kind>', 'model provider for slots that name a model: litellm or foundry')
  .option('--base-url <url>', 'LiteLLM proxy root, or https://<resource>.services.ai.azure.com for Foundry')
  .option('--reviewer-1 <harness:model>', 'run the first reviewer through the provider, e.g. claude:claude-sonnet-4-5')
  .option('--reviewer-2 <harness:model>', 'run the second reviewer through the provider, e.g. codex:gpt-5-codex')
  .option('--synthesis <harness:model>', 'run the synthesis pass through the provider')
  .addHelpText(
    'after',
    '\nEach setting falls back to its YOKE_* env var, then `yoke config set --user`. The API key comes from YOKE_MODEL_PROVIDER_API_KEY or modelProvider.apiKey only.',
  )
  .action(async (number: string | undefined, options: ReviewOptions) => {
    try {
      const flags = {
        'modelProvider.kind': options.provider,
        'modelProvider.baseUrl': options.baseUrl,
        'review.reviewer1': options.reviewer1,
        'review.reviewer2': options.reviewer2,
        'review.synthesis': options.synthesis,
      }
      const settings = resolveSettings(flags, process.env, readUserConfig(userConfigPath()))
      await reviewPr(number, settings, { post: options.post ?? false }, { out: console.log, log: console.error })
    } catch (error) {
      if (!(error instanceof ReviewError || error instanceof ConfigError)) throw error
      console.error(error.message)
      process.exitCode = 1
    }
  })

const config = program.command('config').description('yoke settings')

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
