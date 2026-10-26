import { relative } from 'node:path'

import { Command } from 'commander'

import packageJson from '../package.json' with { type: 'json' }
import { raiseGuide } from './features/pr/guide'
import { PrValidationError, raisePr } from './features/pr/raise'
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

program.parse()
