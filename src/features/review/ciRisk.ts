import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { riskPolicyPath } from './riskPolicy'

const appClientIdVariable = 'YOKE_REVIEW_APP_CLIENT_ID'
export const appKeySecret = 'YOKE_REVIEW_APP_PRIVATE_KEY'

export const appInput = `review-app-client-id: \${{ vars.${appClientIdVariable} }}`

const readme = 'https://github.com/MakerXStudio/yoke/blob/main/src/features/review/README.md#risk-based-approval'

export const examplePolicy = [
  `# Experimental risk-based review, read only from the default branch: ${readme}`,
  '# .github/**, .claude/**, .codex/** and .mcp.json always need a human, whatever this file says.',
  '# approve: approve low-risk PRs as the yoke-review App. merge: also enable auto-merge.',
  'mode: approve',
  '# mergeMethod: squash',
  'lowRisk:',
  "  - '**/*.md'",
  'alwaysHuman:',
  "  - '**/auth/**'",
  "  - 'infra/**'",
  '# An author with fewer merged PRs here is never low risk.',
  'author:',
  '  minMergedPrs: 1',
  '# Logins and org/team slugs exempt from minMergedPrs, as repo admins and deployment environment reviewers are.',
  'trusted: []',
  '# Share of low-risk PRs left for a human to approve instead (0.1 = 1 in 10), labelled yoke-risk-sampled.',
  'sample:',
  '  rate: 0.1',
  '',
].join('\n')

export type PolicyOutcome = 'wrote' | 'kept' | 'printed'

export function writeExamplePolicy(root: string): PolicyOutcome {
  const path = join(root, riskPolicyPath)
  if (existsSync(path)) return 'kept'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, examplePolicy)
  return 'wrote'
}

const appPermissions = [
  ['contents', 'write'],
  ['pull_requests', 'write'],
  ['metadata', 'read'],
  ['members', 'read'],
] as const

function newAppUrl(owner: string): string {
  const query = new URLSearchParams({
    name: 'yoke-review',
    url: 'https://github.com/MakerXStudio/yoke',
    public: 'false',
    webhook_active: 'false',
    ...Object.fromEntries(appPermissions),
  })
  return `https://github.com/organizations/${owner}/settings/apps/new?${query.toString()}`
}

function policyLines(outcome: PolicyOutcome): string[] {
  if (outcome === 'wrote')
    return [
      `Added an example ${riskPolicyPath}. Edit its globs, then merge it to the default branch; risk review reads it only from there.`,
    ]
  if (outcome === 'kept') return [`${riskPolicyPath} already exists, so it was left as it is.`]
  return [
    `Example ${riskPolicyPath}, not saved to the repo; risk review reads it only from the default branch:`,
    '',
    examplePolicy.trimEnd(),
  ]
}

export function riskSetup(outcome: PolicyOutcome, repo: string): string[] {
  const [owner = '<owner>'] = repo.split('/')
  return [
    '',
    'Experimental risk-based review approves, or in merge mode auto-merges, PRs the policy rates low risk, as the yoke-review GitHub App.',
    ...policyLines(outcome),
    '',
    'The App needs no webhook and these permissions: repository Contents read and write, Pull requests read and write, Metadata read; organization Members read.',
    `If your organisation has no such App, create one with those permissions at ${newAppUrl(owner)}`,
    `Install it on this repo only (not all repos), then set its client ID and a private key it generated with:`,
    `  gh variable set ${appClientIdVariable} --body '<client-id>'`,
    `  gh secret set ${appKeySecret} < <private-key>.pem`,
    `Skip them if they are already set for your organisation. Never reuse the yoke-release App: it bypasses yoke's main ruleset.`,
    '',
    `For mode: merge, turn on "Allow auto-merge" at https://github.com/${repo}/settings. On the default branch, require the review / gate check and an approving review, and dismiss stale approvals when new commits are pushed, so a push can't merge on an earlier approval before it is rated again.`,
  ]
}
