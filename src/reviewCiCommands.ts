import type { Command } from 'commander'

import { addSettingOptions, flagSettings, settingsHelp } from './cliSettings'
import { resolveSettings, settingKeys } from './features/config/settings'
import { ConfigError, readUserConfig, userConfigPath } from './features/config/userConfig'
import {
  callerWorkflow,
  callerWorkflowPath,
  type EntraFlags,
  gateCheck,
  githubRepo,
  renderCallerWorkflow,
  repoRoot,
  reviewCiReport,
  writeCallerWorkflow,
} from './features/review/ci'
import { enforceReviewGate } from './features/review/ciGate'
import { writeExamplePolicy } from './features/review/ciRisk'
import { runReviewGate } from './features/review/gate'
import { githubGet, githubPaginate, ReviewError } from './features/review/pr'
import { runPushReview } from './features/review/pushReview'
import { runRiskReview } from './features/review/risk'
import { riskPolicyPath } from './features/review/riskPolicy'
import { runRiskReport } from './features/review/riskReport'
import { runUnapproveReview } from './features/review/unapprove'

const ciKeys = settingKeys.filter((key) => /^review\.\w+\.(harness|model)$/.test(key))

function fail(error: unknown, ...expected: (typeof ReviewError | typeof ConfigError)[]): void {
  if (!expected.some((type) => error instanceof type) || !(error instanceof Error)) throw error
  console.error(error.message)
  process.exitCode = 1
}

const resultHelp =
  'result of the review job on this event: success, failure, cancelled or skipped; pending marks an approved review as running'

async function gate(result: string): Promise<void> {
  try {
    if (!(await runReviewGate(result, console.log))) process.exitCode = 1
  } catch (error) {
    fail(error, ReviewError)
  }
}

async function pushReview(): Promise<void> {
  try {
    await runPushReview(console.log)
  } catch (error) {
    fail(error, ReviewError)
  }
}

async function risk(result: string): Promise<void> {
  try {
    await runRiskReview(result, console.log)
  } catch (error) {
    fail(error, ReviewError)
  }
}

async function riskReport(repos: string[], options: { limit: string }): Promise<void> {
  try {
    const deps = { get: (path: string) => githubGet(path), paginate: (path: string) => githubPaginate(path) }
    await runRiskReport(repos.length ? repos : [githubRepo()], Number(options.limit), console.log, deps)
  } catch (error) {
    fail(error, ReviewError)
  }
}

async function unapprove(): Promise<void> {
  try {
    await runUnapproveReview(console.log)
  } catch (error) {
    fail(error, ReviewError)
  }
}

export function addReviewCiCommands(review: Command): void {
  addSettingOptions(
    review
      .command('ci')
      .description(
        `Write ${callerWorkflowPath} so each PR in this repo is reviewed in CI, then print the secrets, or Entra federated credential, it needs`,
      )
      .option('--provider <provider>', 'litellm or foundry; every slot uses it in CI. Default: review.reviewer1.provider, else litellm')
      .option(
        '--azure-client-id <id>',
        'Entra app (client) ID to sign in to Foundry with GitHub OIDC instead of an API key; needs --provider foundry',
      )
      .option('--azure-tenant-id <id>', 'Entra tenant ID of that app')
      .option('--environment <name>', "GitHub environment the review job runs in, matching the app's federated credential subject")
      .option(
        '--risk',
        `experimental: pass the yoke-review App to the review and write an example ${riskPolicyPath}, so low-risk PRs are approved or auto-merged`,
      )
      .option('--print', `print the workflow and setup commands without writing ${callerWorkflowPath}`),
    ciKeys,
  )
    .addHelpText('after', settingsHelp)
    .action((options: { provider?: string; print?: boolean; risk?: boolean } & EntraFlags & Record<string, unknown>) => {
      try {
        const settings = resolveSettings(flagSettings(options, ciKeys), process.env, readUserConfig(userConfigPath()))
        const workflow = callerWorkflow(settings, options.provider, options, options.risk)
        const root = repoRoot()
        const outcome = options.print ? 'printed' : writeCallerWorkflow(root, renderCallerWorkflow(workflow))
        const policy = options.risk && !options.print ? writeExamplePolicy(root) : undefined
        console.log(reviewCiReport(outcome, settings, workflow, () => githubRepo(root), policy))
      } catch (error) {
        fail(error, ReviewError, ConfigError)
      }
    })

  review
    .command('ci-gate')
    .description(`Require the ${gateCheck} check on the default branch with a ruleset, once the CI review workflow is merged`)
    .action(async () => {
      try {
        console.log((await enforceReviewGate()).message)
      } catch (error) {
        fail(error, ReviewError)
      }
    })

  review
    .command('gate')
    .description(
      "Block merging until the latest review that ran for the PR succeeds, or for a fork PR, a review approved by a user with write access adding the `review` label; bot PRs pass. On pull_request_target, records the approved review on the PR head and re-runs its gate. Used by review.yml's review and gate jobs",
    )
    .argument('<result>', resultHelp)
    .action(gate)

  review
    .command('risk')
    .description(
      "Experimental: rate the PR's risk with `.github/yoke-risk.yml` from the default branch, approve it as the yoke-review App when it is low (and enable auto-merge in merge mode, or withdraw both on a later run that is not low), and add a ## Risk section to the posted review. Used by review.yml's review job",
    )
    .argument('<result>', 'outcome of the review step: success, failure, cancelled or skipped')
    .action(risk)

  review
    .command('risk-report')
    .description(
      "Experimental: list each repo's recent risk decisions, which were auto-approved, and the human verdict on each PR sampled for a human check, to tune .github/yoke-risk.yml",
    )
    .argument('[repos...]', 'owner/repo to report on; default: the current repo')
    .option('--limit <n>', 'most recently updated PRs to read per repo, up to 100', '30')
    .action(riskReport)

  review
    .command('unapprove')
    .description(
      "Remove the `review` label from a fork PR after a push, so a maintainer reads the new commits before they are reviewed. Used by review.yml's unapprove job on pull_request_target",
    )
    .action(unapprove)
}

export function addLockedWorkflowAliases(program: Command): void {
  program.command('review-gate', { hidden: true }).argument('<result>', resultHelp).action(gate)
  program.command('review-unapprove', { hidden: true }).action(unapprove)
  program.command('review-push', { hidden: true }).action(pushReview)
  program.command('review-risk', { hidden: true }).argument('<result>').action(risk)
}
