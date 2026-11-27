import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkRiskSetup, renderChecklist } from './ciRiskCheck'
import type { RiskApi } from './ciRiskMerge'
import { ReviewError } from './pr'

const callerYaml = (withExtra = '', secretsExtra = '') => `name: Review PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_target:
    types: [labeled, synchronize]
permissions:
  actions: write
  contents: read
  pull-requests: write
  statuses: write
jobs:
  review:
    uses: MakerXStudio/yoke/.github/workflows/review.yml@main
    with:
      reviewer1-model: m${withExtra}
    secrets:
      REVIEW_CI_API_KEY: \${{ secrets.REVIEW_CI_API_KEY }}${secretsExtra}
`

const withApp = callerYaml(
  '\n      review-app-client-id: ${{ vars.YOKE_REVIEW_APP_CLIENT_ID }}',
  '\n      YOKE_REVIEW_APP_PRIVATE_KEY: ${{ secrets.YOKE_REVIEW_APP_PRIVATE_KEY }}',
)

const gateRule = { type: 'required_status_checks', ruleset_id: 7, parameters: { required_status_checks: [{ context: 'review / gate' }] } }

const approvalRule = {
  type: 'pull_request',
  ruleset_id: 8,
  parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true },
}

const appStep = (conclusion: string | null) => ({ name: 'Get a yoke-review App token for the risk review', conclusion })

const tokenLog = (error = '') =>
  [
    '2026-11-24T05:55:14Z ##[group]Run actions/create-github-app-token@v3',
    '2026-11-24T05:55:14Z   client-id: ***',
    '2026-11-24T05:55:14Z ##[endgroup]',
    ...(error ? [`2026-11-24T05:55:15Z ##[error]${error}`] : []),
    '2026-11-24T05:55:15Z ##[group]Run yoke review risk "$REVIEW_RESULT"',
    '2026-11-24T05:55:16Z ##[error]Process completed with exit code 1.',
  ].join('\n')

const riskBody = (extra = '') => `## Adversarial review\n\nNo findings.\n\n## Risk\n\n**Decision:** medium risk, needs a human${extra}`

type Review = { id: number; body: string; user: { login: string } }

type FakeOptions = {
  owner?: { login: string; type: string }
  rules?: unknown[]
  workflow?: string | null
  repoVariables?: string[]
  sharedVariables?: string[] | null
  orgVariable?: { visibility: string } | null
  sharedSecrets?: string[]
  policy?: string | null
  runs?: { id: number; steps: { name: string; conclusion: string | null }[]; log?: string }[]
  reviews?: Review[]
  postStatus?: number
  autoMerge?: boolean
  classic?: unknown
  rulesets?: { id: number; name: string; enforcement: string }[]
  local?: Record<string, string>
}

const encode = (text: string) => Buffer.from(text).toString('base64')

function fakeApi({
  owner = { login: 'o', type: 'Organization' },
  rules = [gateRule, approvalRule],
  workflow = withApp,
  repoVariables = [],
  sharedVariables = ['YOKE_REVIEW_APP_CLIENT_ID'],
  orgVariable = null,
  sharedSecrets = ['YOKE_REVIEW_APP_PRIVATE_KEY'],
  policy = 'mode: merge\n',
  runs = [{ id: 1, steps: [appStep('success')] }],
  reviews = [{ id: 9, body: riskBody(), user: { login: 'github-actions[bot]' } }],
  postStatus,
  autoMerge = true,
  classic,
  rulesets = [],
}: FakeOptions = {}) {
  const posts: [string, unknown][] = []
  const patches: [string, unknown][] = []
  const repo = {
    full_name: 'o/r',
    html_url: 'https://github.com/o/r',
    default_branch: 'main',
    owner,
    private: false,
    allow_auto_merge: autoMerge,
  }
  const responses = new Map<string, unknown>([
    ['repos/{owner}/{repo}', repo],
    ['repos/o/r', repo],
    ['repos/o/r/rules/branches/main', rules],
    ['repos/o/r/rulesets?includes_parents=false&per_page=100', rulesets],
    [
      'repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=20',
      [{ number: 5, html_url: 'https://github.com/o/r/pull/5', head: { sha: 'a' } }],
    ],
    ['repos/o/r/commits/a/check-runs?check_name=review%20%2F%20gate&per_page=1', { total_count: 1 }],
    ['repos/o/r/actions/organization-secrets?per_page=100', { secrets: sharedSecrets.map((name) => ({ name })) }],
    ['repos/o/r/pulls/5/reviews?per_page=100', reviews],
    [
      'repos/o/r/actions/workflows/review-pr.yml/runs?event=pull_request&per_page=10',
      { workflow_runs: runs.map(({ id }) => ({ id, html_url: `https://github.com/o/r/actions/runs/${id}` })) },
    ],
    ...runs.map(
      ({ id, steps }) =>
        [
          `repos/o/r/actions/runs/${id}/jobs?per_page=100`,
          {
            jobs: [
              { id: id * 100 + 1, steps: [] },
              { id: id * 100, steps },
            ],
          },
        ] as const,
    ),
    ...repoVariables.map((name) => [`repos/o/r/actions/variables/${name}`, { name }] as const),
  ])
  if (classic) responses.set('repos/o/r/branches/main/protection', classic)
  if (sharedVariables)
    responses.set('repos/o/r/actions/organization-variables?per_page=100', { variables: sharedVariables.map((name) => ({ name })) })
  if (orgVariable) responses.set('orgs/o/actions/variables/YOKE_REVIEW_APP_CLIENT_ID', orgVariable)
  if (workflow !== null) {
    responses.set('repos/o/r/contents/.github/workflows?ref=main', [
      { type: 'file', name: 'review-pr.yml', path: '.github/workflows/review-pr.yml' },
    ])
    responses.set('repos/o/r/contents/.github/workflows/review-pr.yml?ref=main', { content: encode(workflow) })
  }
  if (policy !== null) {
    responses.set('repos/o/r/contents/.github/yoke-risk.yml?ref=main', {
      content: encode(policy),
      html_url: 'https://github.com/o/r/blob/main/.github/yoke-risk.yml',
    })
    responses.set('repos/o/r/commits?path=.github/yoke-risk.yml&sha=main&per_page=1', [{ sha: 'p' }])
  }
  const refuse = (path: string) => {
    if (postStatus) throw new ReviewError(`\`gh api ${path}\` failed: gh: Request refused (HTTP ${postStatus})`)
  }
  const api: RiskApi = {
    get: async (path) => {
      if (responses.has(path)) return responses.get(path)
      const status = path.startsWith('orgs/') || path.includes('organization-') ? 403 : 404
      throw new ReviewError(`\`gh api ${path}\` failed: gh: Not Found (HTTP ${status})`)
    },
    post: async (path, body) => {
      posts.push([path, body])
      refuse(path)
      return { id: 42 }
    },
    patch: async (path, body) => {
      patches.push([path, body])
      refuse(path)
      return {}
    },
    log: async (path) => {
      const run = runs.find(({ id }) => path === `repos/o/r/actions/jobs/${id * 100}/logs`)
      if (!run) throw new ReviewError(`\`gh api ${path}\` failed: gh: Not Found (HTTP 404)`)
      return run.log ?? tokenLog()
    },
  }
  return Object.assign(api, { posts, patches })
}

function checkout(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ci-risk-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

async function check(options: FakeOptions = {}) {
  const api = fakeApi(options)
  const root = checkout(options.local)
  const result = await checkRiskSetup(api, root)
  const byName = (name: string) => {
    const found = result.checks.find((entry) => entry.name === name)
    if (!found) throw new Error(`no ${name} check`)
    return found
  }
  return { api, root, result, byName }
}

describe('checkRiskSetup', () => {
  it('passes every requirement of a working setup and changes nothing', async () => {
    const { api, result } = await check()
    expect(result.checks.map(({ name, passed }) => [name, passed])).toEqual([
      ['Gate', true],
      ['Workflow', true],
      ['Org variable', true],
      ['Org secret', true],
      ['Policy', true],
      ['Merge mode', true],
      ['App installed', true],
      ['Working', true],
    ])
    expect(api.posts).toEqual([])
    expect(api.patches).toEqual([])
    expect(renderChecklist(result)).toContain('Every requirement passes')
  })

  it('requires review / gate itself when ci-gate can', async () => {
    const { api, byName } = await check({ rules: [approvalRule] })
    expect(api.posts.map(([path]) => path)).toEqual(['repos/o/r/rulesets'])
    expect(byName('Gate')).toMatchObject({ passed: true, detail: expect.stringContaining('https://github.com/o/r/rules/42') })
  })

  it("shows ci-gate's reason when it can't require the gate yet", async () => {
    const { api, byName } = await check({ rules: [approvalRule], workflow: null })
    expect(api.posts).toEqual([])
    expect(byName('Gate')).toMatchObject({
      passed: false,
      detail: expect.stringContaining("No workflow on main calls yoke's review.yml"),
    })
  })

  it("fails the workflow when the default branch's caller lacks the App input and secret", async () => {
    const { byName } = await check({ workflow: callerYaml() })
    const workflow = byName('Workflow')
    expect(workflow.passed).toBe(false)
    expect(workflow.detail).toContain('https://github.com/o/r/blob/main/.github/workflows/review-pr.yml')
    expect(workflow.detail).toContain("doesn't pass the `review-app-client-id` input or the `YOKE_REVIEW_APP_PRIVATE_KEY` secret")
  })

  it('accepts secrets: inherit for the private key', async () => {
    const workflow = withApp.replace(/ {4}secrets:\n(?: {6}.*\n)+/, '    secrets: inherit\n')
    const { byName } = await check({ workflow })
    expect(byName('Workflow').passed).toBe(true)
  })

  it('passes a variable set on the repo itself', async () => {
    const { byName } = await check({ sharedVariables: [], repoVariables: ['YOKE_REVIEW_APP_CLIENT_ID'] })
    expect(byName('Org variable').passed).toBe(true)
  })

  it('fails only when the org shares the variable with selected repos that exclude this one, with the org settings link', async () => {
    const { byName } = await check({ sharedVariables: [], orgVariable: { visibility: 'selected' } })
    expect(byName('Org variable')).toEqual({
      name: 'Org variable',
      passed: false,
      detail:
        'o shares YOKE_REVIEW_APP_CLIENT_ID only with selected repos, which excludes o/r. An org owner can add it at https://github.com/organizations/o/settings/variables/actions/YOKE_REVIEW_APP_CLIENT_ID',
    })
  })

  it("passes a variable it can't see rather than guess the org's settings", async () => {
    const { byName } = await check({ sharedVariables: null })
    expect(byName('Org variable').passed).toBe(true)
  })

  it('passes an org-wide variable', async () => {
    const { byName } = await check({ sharedVariables: [], orgVariable: { visibility: 'all' } })
    expect(byName('Org variable').passed).toBe(true)
  })

  it('fails a missing policy with a link to the default branch', async () => {
    const { byName } = await check({ policy: null })
    expect(byName('Policy')).toMatchObject({
      passed: false,
      detail: expect.stringContaining('No .github/yoke-risk.yml on main: https://github.com/o/r/tree/main/.github'),
    })
  })

  it("shows an invalid policy's parse error", async () => {
    const { byName } = await check({ policy: 'mode: yolo\n' })
    const policy = byName('Policy')
    expect(policy.passed).toBe(false)
    expect(policy.detail).toContain('https://github.com/o/r/blob/main/.github/yoke-risk.yml: .github/yoke-risk.yml is invalid')
  })

  it("fails on the local policy's parse error, so a draft is checked before it is merged", async () => {
    const { byName } = await check({ local: { '.github/yoke-risk.yml': 'mode: yolo\n' } })
    const policy = byName('Policy')
    expect(policy.passed).toBe(false)
    expect(policy.detail).toMatch(/^The local \.github\/yoke-risk\.yml is invalid/)
  })

  it('reports the App as not installed from a failed App token step, with the install link', async () => {
    const { byName } = await check({
      runs: [
        { id: 3, steps: [appStep('skipped')] },
        { id: 2, steps: [appStep('failure')] },
      ],
    })
    expect(byName('App installed')).toEqual({
      name: 'App installed',
      passed: false,
      detail:
        "The App token step failed in https://github.com/o/r/actions/runs/2: the yoke-review App isn't installed on o/r. An org owner can install it at https://github.com/organizations/o/settings/apps/yoke-review/installations",
    })
  })

  it('reports the App as not installed when the continue-on-error token step logged an error, though its conclusion is success', async () => {
    const { byName } = await check({ runs: [{ id: 2, steps: [appStep('success')], log: tokenLog('Not Found') }] })
    expect(byName('App installed')).toMatchObject({
      passed: false,
      detail: expect.stringContaining('The App token step failed in https://github.com/o/r/actions/runs/2'),
    })
  })

  it("passes the App when the token step's log has no error, ignoring later steps' errors", async () => {
    const { byName } = await check({ runs: [{ id: 2, steps: [appStep('success')], log: tokenLog() }] })
    expect(byName('App installed')).toMatchObject({ passed: true, detail: expect.stringContaining('actions/runs/2') })
  })

  it('waits for a run that tries the App token', async () => {
    const { byName } = await check({ runs: [{ id: 3, steps: [appStep('skipped')] }] })
    expect(byName('App installed')).toMatchObject({ passed: false, detail: expect.stringContaining('No review run has tried') })
  })

  it('lists opening or pushing to a PR last until a ## Risk section is posted', async () => {
    const { result } = await check({ reviews: [] })
    const last = result.checks.at(-1)
    expect(last).toMatchObject({ name: 'Working', passed: false, detail: expect.stringContaining('open or push to a PR') })
  })

  it('fails a ## Risk section posted without the App', async () => {
    const body = riskBody('\n\n- no `yoke-review` App token: the App is not configured')
    const { byName } = await check({ reviews: [{ id: 9, body, user: { login: 'github-actions[bot]' } }] })
    expect(byName('Working')).toMatchObject({
      passed: false,
      detail: expect.stringContaining('https://github.com/o/r/pull/5#pullrequestreview-9'),
    })
  })
})

const localCaller = '.github/workflows/review-pr.yml'

describe('checkRiskSetup workflow edit', () => {
  it("adds the App input and secret to the local caller when the default branch's copy lacks them", async () => {
    const { root, byName } = await check({ workflow: callerYaml(), local: { [localCaller]: callerYaml() } })
    expect(readFileSync(join(root, localCaller), 'utf8')).toBe(withApp)
    expect(byName('Workflow')).toMatchObject({
      passed: false,
      detail: expect.stringContaining(
        'Added `review-app-client-id` and `YOKE_REVIEW_APP_PRIVATE_KEY` to the local .github/workflows/review-pr.yml; commit it and merge it to main.',
      ),
    })
  })

  it('adds them to a local caller not yet on the default branch', async () => {
    const { root, byName } = await check({ workflow: null, local: { [localCaller]: callerYaml() } })
    expect(readFileSync(join(root, localCaller), 'utf8')).toBe(withApp)
    expect(byName('Workflow').detail).toContain("No workflow on main calls yoke's review.yml. Added")
  })

  it('says to merge a local caller that already passes them', async () => {
    const { byName } = await check({ workflow: callerYaml(), local: { [localCaller]: withApp } })
    expect(byName('Workflow').detail).toContain(
      'The local .github/workflows/review-pr.yml already passes them; commit it and merge it to main.',
    )
  })

  it("leaves the local caller alone when the default branch's copy passes them", async () => {
    const { root } = await check({ local: { [localCaller]: callerYaml() } })
    expect(readFileSync(join(root, localCaller), 'utf8')).toBe(callerYaml())
  })

  it('says to run this in a checkout when there is no local caller', async () => {
    const { byName } = await check({ workflow: callerYaml() })
    expect(byName('Workflow').detail).toContain('Run this again in a checkout with .github/workflows/review-pr.yml.')
  })
})

describe('checkRiskSetup merge mode', () => {
  it('turns on Allow auto-merge and adds the yoke risk ruleset when nothing requires an approval', async () => {
    const { api, byName } = await check({ autoMerge: false, rules: [gateRule] })
    expect(api.patches).toEqual([['repos/o/r', { allow_auto_merge: true }]])
    expect(api.posts).toEqual([
      [
        'repos/o/r/rulesets',
        expect.objectContaining({
          name: 'yoke risk',
          enforcement: 'active',
          rules: [
            {
              type: 'pull_request',
              parameters: expect.objectContaining({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true }),
            },
          ],
        }),
      ],
    ])
    expect(byName('Merge mode')).toEqual({
      name: 'Merge mode',
      passed: true,
      detail:
        'Turned on Allow auto-merge: https://github.com/o/r/settings Added the "yoke risk" ruleset, which requires 1 approval on main and dismisses stale approvals on push: https://github.com/o/r/rules/42',
    })
  })

  it('changes nothing when classic protection requires an approval and dismisses stale ones', async () => {
    const classic = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true } }
    const { api, byName } = await check({ rules: [gateRule], classic })
    expect(api.posts).toEqual([])
    expect(byName('Merge mode')).toMatchObject({
      passed: true,
      detail: expect.stringContaining('https://github.com/o/r/settings/branches'),
    })
  })

  it("adds the ruleset when classic protection doesn't dismiss stale approvals", async () => {
    const classic = { required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: false } }
    const { api } = await check({ rules: [gateRule], classic })
    expect(api.posts.map(([path]) => path)).toEqual(['repos/o/r/rulesets'])
  })

  it('points to an existing yoke risk ruleset that requires nothing instead of adding another', async () => {
    const { api, byName } = await check({ rules: [gateRule], rulesets: [{ id: 3, name: 'yoke risk', enforcement: 'disabled' }] })
    expect(api.posts).toEqual([])
    expect(byName('Merge mode')).toMatchObject({ passed: false, detail: expect.stringContaining('https://github.com/o/r/rules/3') })
  })

  it('fails with what a repo admin must do when GitHub refuses the changes', async () => {
    const { byName } = await check({ autoMerge: false, rules: [gateRule], postStatus: 403 })
    const merge = byName('Merge mode')
    expect(merge.passed).toBe(false)
    expect(merge.detail).toContain("Your gh user can't turn on Allow auto-merge; a repo admin can at https://github.com/o/r/settings")
    expect(merge.detail).toContain('Ask a repo admin to run `yoke review ci-risk`.')
  })

  it('needs no merge settings in approve mode', async () => {
    const { api, byName } = await check({ policy: 'mode: approve\n', autoMerge: false, rules: [gateRule] })
    expect(api.patches).toEqual([])
    expect(api.posts).toEqual([])
    expect(byName('Merge mode').passed).toBe(true)
  })

  it('follows the local policy before it is merged', async () => {
    const { api } = await check({ policy: null, autoMerge: false, local: { '.github/yoke-risk.yml': 'mode: merge\n' } })
    expect(api.patches).toEqual([['repos/o/r', { allow_auto_merge: true }]])
  })
})

describe('renderChecklist', () => {
  it('prints a pass or fail line per requirement and counts the failures', () => {
    const text = renderChecklist({
      repo: 'o/r',
      checks: [
        { name: 'Gate', passed: true, detail: 'ok' },
        { name: 'Policy', passed: false, detail: 'line one\nline two' },
      ],
    })
    expect(text).toBe(
      ['Risk-based review setup for o/r:', '✓ Gate: ok', '✗ Policy: line one', '    line two', '', '1 of 2 requirements not met yet.'].join(
        '\n',
      ),
    )
  })
})
