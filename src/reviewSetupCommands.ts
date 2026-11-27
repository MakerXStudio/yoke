import type { Command } from 'commander'

import { fail } from './cliFail'
import { gateCheck } from './features/review/ci'
import { enforceReviewGate } from './features/review/ciGate'
import { examplePolicy } from './features/review/ciRisk'
import { checkRiskSetup, renderChecklist } from './features/review/ciRiskCheck'
import { ReviewError } from './features/review/pr'
import { riskPolicyPath } from './features/review/riskPolicy'

async function riskSetup({ examplePolicy: printExample }: { examplePolicy?: boolean }): Promise<void> {
  if (printExample) {
    process.stdout.write(examplePolicy)
    return
  }
  try {
    const result = await checkRiskSetup()
    console.log(renderChecklist(result))
    if (result.checks.some((check) => !check.passed)) process.exitCode = 1
  } catch (error) {
    fail(error, ReviewError)
  }
}

export function addSetupCommands(review: Command): void {
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
    .command('ci-risk')
    .description(
      `Check each requirement of risk-based review against GitHub (the ${gateCheck} check, which it requires itself when it can, the caller's App inputs, which it adds to the local caller, the org variable and secret, ${riskPolicyPath}, merge-mode settings, which it turns on, the App install and a posted ## Risk section) and print a checklist; exits non-zero until all pass`,
    )
    .option('--example-policy', `print an example ${riskPolicyPath}, with comments, and check nothing`)
    .action(riskSetup)
}
