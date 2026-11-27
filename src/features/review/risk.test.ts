import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { Finding, Synthesis } from './findings'
import type { GateContext } from './gate'
import { ReviewError } from './pr'
import { appClient, cachedFindings, type RiskDeps, riskReview, runRiskReview } from './risk'
import { withRiskSection } from './riskDecision'
import type { AppClient } from './riskMerge'

const head = 'a'.repeat(40)
const policySha = 'b'.repeat(40)

function context(eventName: GateContext['eventName'] = 'pull_request'): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    eventName,
    event: {
      action: 'opened',
      pull_request: {
        number: 5,
        head: { ref: 'f', sha: head, repo: { full_name: 'o/r' } },
        user: { type: 'User' },
      },
    },
  }
}

const finding = (severity: Finding['severity']): Finding => ({
  title: 't',
  severity,
  source: 'confirmed',
  file: null,
  line: null,
  impact: '',
  recommendation: '',
})

type Fixture = {
  policy?: string | null
  files?: { filename: string; previous_filename?: string }[]
  changedFiles?: number
  fork?: boolean
  userType?: string
  reviews?: unknown[]
  synthesis?: Synthesis | null
  app?: boolean
  autoMerge?: { enabled_by: { login: string } } | null
  repoSettings?: Record<string, boolean>
  history?: { merged: number } | Error
  permission?: string
  environments?: unknown[]
  teams?: string[]
  labels?: string[]
  roll?: number
}

const postedBody = '## Adversarial review\n\nLooks fine.'

function deps({
  policy = 'lowRisk: ["**/*.md"]\nalwaysHuman: ["src/auth/**"]',
  files = [{ filename: 'README.md' }],
  changedFiles = files.length,
  fork = false,
  userType = 'User',
  reviews = [
    {
      id: 77,
      body: postedBody,
      state: 'COMMENTED',
      commit_id: head,
      user: { login: 'github-actions[bot]' },
    },
  ],
  synthesis = { summary: 's', findings: [finding('minor')] },
  app = true,
  autoMerge = null,
  repoSettings = { allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true },
  history = { merged: 5 },
  permission = 'write',
  environments = [],
  teams = [],
  labels = [],
  roll = 0.5,
}: Fixture = {}) {
  const random = vi.fn(() => roll)
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === 'repos/o/r') return { default_branch: 'main' }
    if (path === 'repos/o/r/contents/.github/yoke-risk.yml?ref=main') {
      if (policy === null) throw new Error('`gh api x` failed: gh: Not Found (HTTP 404)')
      return {
        content: Buffer.from(policy).toString('base64'),
        html_url: 'https://github.com/o/r/blob/main/.github/yoke-risk.yml',
      }
    }
    if (path === 'repos/o/r/commits?path=.github/yoke-risk.yml&sha=main&per_page=1') return [{ sha: policySha }]
    if (path === 'repos/o/r/collaborators/dev/permission') return { permission, role_name: permission }
    if (path === 'repos/o/r/environments?per_page=100') return { total_count: environments.length, environments }
    if (path === 'repos/o/r/pulls/5')
      return {
        number: 5,
        node_id: 'PR_5',
        html_url: 'https://github.com/o/r/pull/5',
        auto_merge: autoMerge,
        changed_files: changedFiles,
        user: {
          login: userType === 'Bot' ? 'dependabot[bot]' : 'dev',
          type: userType,
        },
        head: { sha: head, repo: { full_name: fork ? 'fork/r' : 'o/r' } },
        base: { sha: 'c'.repeat(40) },
        labels: labels.map((name) => ({ name })),
      }
    throw new Error(`unexpected GET ${path}`)
  })
  const paginate = vi.fn(async (path: string): Promise<unknown[]> => {
    if (path === 'repos/o/r/pulls/5/files?per_page=100') return files
    if (path === 'repos/o/r/pulls/5/reviews?per_page=100') return reviews
    throw new Error(`unexpected paginate ${path}`)
  })
  const put = vi.fn(async () => ({}))
  const searches = vi.fn(async (_query: string, _variables: Record<string, string>): Promise<unknown> => {
    if (history instanceof Error) throw history
    return {
      data: {
        search: { issueCount: history.merged },
      },
    }
  })
  const approve = vi.fn(async () => ({}))
  const appPut = vi.fn(async () => ({}))
  const graphql = vi.fn(async () => ({}))
  const log = vi.fn()
  const client: AppClient = {
    login: 'yoke-review[bot]',
    get: async (path) => {
      if (path === 'repos/o/r') return { default_branch: 'main', ...repoSettings }
      const membership = /^orgs\/(.+)\/teams\/(.+)\/memberships\/dev$/.exec(path)
      if (membership) {
        if (teams.includes(`${membership[1]}/${membership[2]}`)) return { state: 'active' }
        throw new ReviewError('`gh api x` failed: gh: Not Found (HTTP 404)')
      }
      throw new Error(`unexpected App GET ${path}`)
    },
    post: approve,
    put: appPut,
    graphql,
  }
  const riskDeps: RiskDeps = {
    get,
    paginate,
    put,
    graphql: searches,
    app: app ? client : undefined,
    findings: () => synthesis,
    log,
    random,
  }
  return { riskDeps, get, put, approve, appPut, graphql, searches, log, random }
}

const reviewers = (reviewer: unknown) => [
  { name: 'production', protection_rules: [{ type: 'wait_timer' }, { type: 'required_reviewers', reviewers: [reviewer] }] },
]

describe('riskReview', () => {
  it('does nothing when the default branch has no policy', async () => {
    const { riskDeps, put, approve } = deps({ policy: null })
    expect(await riskReview('success', context(), riskDeps)).toBe('No .github/yoke-risk.yml on the default branch, so risk review is off.')
    expect(put).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })

  it('approves a low-risk PR on its exact head and records the evidence on the posted review', async () => {
    const { riskDeps, put, approve } = deps()
    const section = await riskReview('success', context(), riskDeps)
    expect(section).toBe(
      [
        '## Risk',
        '**Decision:** low risk, approved by `yoke-review`',
        '- every changed file matches `lowRisk` in the policy',
        '**Author:** passes: `dev` has 5 merged PRs here (at least 1)',
        `Head: \`${head}\` · Policy: [\`.github/yoke-risk.yml\`](https://github.com/o/r/blob/main/.github/yoke-risk.yml) at \`${policySha}\` on \`main\` · Mode: \`approve\``,
      ].join('\n\n'),
    )
    expect(approve).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews', {
      commit_id: head,
      event: 'APPROVE',
      body: section,
    })
    expect(put).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews/77', {
      body: `${postedBody}\n\n${section}`,
    })
  })

  it('reads the policy from the default branch, so a PR editing it is rated high', async () => {
    const { riskDeps, get, approve } = deps({
      files: [{ filename: 'README.md' }, { filename: '.github/yoke-risk.yml' }],
    })
    const section = await riskReview('success', context(), riskDeps)
    expect(section).toContain('**Decision:** high risk, needs a human')
    expect(get).toHaveBeenCalledWith('repos/o/r/contents/.github/yoke-risk.yml?ref=main')
    expect(approve).not.toHaveBeenCalled()
  })

  it('rates a file renamed out of a hard exclusion high', async () => {
    const { riskDeps, approve } = deps({
      files: [
        {
          filename: 'docs/ci.md',
          previous_filename: '.github/workflows/ci.md',
        },
      ],
    })
    expect(await riskReview('success', context(), riskDeps)).toContain('high risk')
    expect(approve).not.toHaveBeenCalled()
  })

  it('rates an alwaysHuman file high', async () => {
    const { riskDeps, approve } = deps({
      files: [{ filename: 'src/auth/notes.md' }],
    })
    expect(await riskReview('success', context(), riskDeps)).toContain('matches `alwaysHuman`')
    expect(approve).not.toHaveBeenCalled()
  })

  it('approves a file outside the globs when the AI rates it low, recording its reason', async () => {
    const { riskDeps, approve } = deps({
      files: [{ filename: 'src/api.ts' }],
      synthesis: { summary: 's', findings: [], risk: { level: 'low', reason: 'Renames a local variable.' } },
    })
    const section = await riskReview('success', context(), riskDeps)
    expect(section).toContain('**Decision:** low risk, approved by `yoke-review`')
    expect(section).toContain('- AI risk rating: low: Renames a local variable.')
    expect(approve).toHaveBeenCalledOnce()
  })

  it.each<[string, Synthesis['risk'], string]>([
    ['medium', { level: 'medium', reason: 'Changes API behaviour.' }, '**Decision:** medium risk, needs a human'],
    ['high', { level: 'high', reason: 'Touches token handling.' }, '**Decision:** high risk, needs a human'],
    ['missing', null, 'the synthesis gave no readable AI risk rating'],
  ])('leaves a file outside the globs to a human when the AI rating is %s', async (_, risk, expected) => {
    const { riskDeps, approve } = deps({ files: [{ filename: 'src/api.ts' }], synthesis: { summary: 's', findings: [], risk } })
    expect(await riskReview('success', context(), riskDeps)).toContain(expected)
    expect(approve).not.toHaveBeenCalled()
  })

  it('keeps a hard exclusion high when the AI rates it low', async () => {
    const { riskDeps, approve } = deps({
      files: [{ filename: '.claude/settings.json' }],
      synthesis: { summary: 's', findings: [], risk: { level: 'low', reason: 'Config only.' } },
    })
    const section = await riskReview('success', context(), riskDeps)
    expect(section).toContain('**Decision:** high risk, needs a human')
    expect(section).toContain('AI risk rating: low: Config only. (not used, the globs decide)')
    expect(approve).not.toHaveBeenCalled()
  })

  it.each<[string, Fixture, string, string?]>([
    ['the review failed', {}, 'the review finished with failure', 'failure'],
    [
      'the review raised a major finding',
      {
        synthesis: {
          summary: '',
          findings: [finding('major'), finding('blocker')],
        },
      },
      'raised 2 blocker or major',
    ],
    ["the review's findings are missing", { synthesis: null }, 'findings could not be read'],
    [
      'no review was posted on the head',
      {
        reviews: [
          {
            id: 1,
            body: postedBody,
            state: 'COMMENTED',
            commit_id: 'old',
            user: { login: 'github-actions[bot]' },
          },
        ],
      },
      'no successful review was posted',
    ],
    [
      'a person posted the review',
      {
        reviews: [
          {
            id: 1,
            body: postedBody,
            state: 'COMMENTED',
            commit_id: head,
            user: { login: 'mallory' },
          },
        ],
      },
      'no successful review was posted',
    ],
    ['the PR is from a fork', { fork: true }, 'the PR is from a fork'],
    ['the PR is from a bot', { userType: 'Bot' }, 'the PR is from a bot (dependabot[bot])'],
    ['the App is not configured', { app: false }, 'no `yoke-review` App token'],
    ['GitHub listed only some files', { changedFiles: 4000 }, 'GitHub listed 1 of the PR'],
    ['the policy is invalid', { policy: 'mode: yolo' }, '.github/yoke-risk.yml is invalid'],
  ])('does not approve a low-risk PR when %s', async (_, fixture, reason, result = 'success') => {
    const { riskDeps, approve } = deps(fixture)
    const section = await riskReview(result, context(), riskDeps)
    expect(section).toContain('needs a human')
    expect(section).toContain(reason)
    expect(approve).not.toHaveBeenCalled()
  })

  describe('author track record', () => {
    it("searches the repo for the author's merged PRs", async () => {
      const { riskDeps, searches } = deps()
      await riskReview('success', context(), riskDeps)
      expect(searches).toHaveBeenCalledWith(expect.stringContaining('issueCount'), {
        q: 'repo:o/r is:pr is:merged author:dev',
      })
    })

    it.each<[string, Fixture, string]>([
      ['a first-time author', { history: { merged: 0 } }, '`dev` has 0 merged PRs here (at least 1), so is a first-time author'],
      [
        'an author below the policy minimum',
        { policy: 'lowRisk: ["**/*.md"]\nauthor:\n  minMergedPrs: 10', permission: 'maintain' },
        'has 5 merged PRs here (at least 10), so is a first-time author',
      ],
      [
        'an author whose history cannot be read',
        { history: new ReviewError('`gh api graphql` failed: boom') },
        'track record could not be read: `gh api graphql` failed: boom',
      ],
    ])('does not approve %s', async (_, fixture, outcome) => {
      const { riskDeps, approve } = deps(fixture)
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('**Decision:** low risk, needs a human')
      expect(section).toContain("- the author's track record does not pass the policy")
      expect(section).toContain(`**Author:** fails: `)
      expect(section).toContain(outcome)
      expect(approve).not.toHaveBeenCalled()
    })

    const firstTime = { history: { merged: 0 } }

    it.each<[string, Fixture, string]>([
      ['listed as trusted', { policy: 'lowRisk: ["**/*.md"]\ntrusted: [Dev]' }, 'is listed as `trusted` in the policy'],
      ['a repo admin', { permission: 'admin' }, 'is a repo admin'],
      [
        'a required reviewer of an environment',
        { environments: reviewers({ type: 'User', reviewer: { login: 'dev' } }) },
        'is a required reviewer of the `production` environment',
      ],
      [
        'in a team that reviews an environment',
        { environments: reviewers({ type: 'Team', reviewer: { slug: 'leads' } }), teams: ['o/leads'] },
        'is a required reviewer of the `production` environment, through the `o/leads` team',
      ],
      [
        'in a team listed as trusted',
        { policy: 'lowRisk: ["**/*.md"]\ntrusted: [o/other, o/leads]', teams: ['o/leads'] },
        'is in the `o/leads` team listed as `trusted` in the policy',
      ],
    ])('approves a first-time author who is %s', async (_, fixture, reason) => {
      const { riskDeps, approve } = deps({ ...firstTime, ...fixture })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain(
        `**Author:** passes: \`dev\` has 0 merged PRs here (at least 1), but ${reason}, so the first-time rule does not apply`,
      )
      expect(approve).toHaveBeenCalledOnce()
    })

    it('records the exemptions it could not check', async () => {
      const { riskDeps, approve } = deps({
        ...firstTime,
        app: false,
        policy: 'lowRisk: ["**/*.md"]\ntrusted: [o/leads]',
      })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('could not check every exemption: team `o/leads` needs the `yoke-review` App to check its members')
      expect(approve).not.toHaveBeenCalled()
    })

    it("does not check a bot's track record", async () => {
      const { riskDeps, searches } = deps({ userType: 'Bot' })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('**Author:** fails: `dependabot[bot]` is a bot, so its track record is not checked')
      expect(section).not.toContain('track record does not pass')
      expect(searches).not.toHaveBeenCalled()
    })

    it('shows the author check on a PR that is not low risk', async () => {
      const { riskDeps } = deps({ files: [{ filename: 'src/auth/login.ts' }] })
      expect(await riskReview('success', context(), riskDeps)).toContain('**Author:** passes: ')
    })
  })

  describe('merge mode', () => {
    const mergePolicy = 'mode: merge\nlowRisk: ["**/*.md"]'
    const appApproval = { id: 40, body: '## Risk', state: 'APPROVED', commit_id: 'old', user: { login: 'yoke-review[bot]' } }

    it('approves, then enables auto-merge as the App on the exact head with the first allowed method', async () => {
      const { riskDeps, approve, graphql, put } = deps({ policy: mergePolicy })
      const section = await riskReview('success', context(), riskDeps)
      expect(approve).toHaveBeenCalledOnce()
      expect(approve.mock.invocationCallOrder[0]).toBeLessThan(graphql.mock.invocationCallOrder[0] ?? 0)
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('enablePullRequestAutoMerge'), {
        pr: 'PR_5',
        method: 'SQUASH',
        head,
      })
      expect(section).toContain(
        '**Actions:**\n- auto-merge enabled as `yoke-review[bot]` with the `squash` method, the first the repo allows of squash, merge and rebase',
      )
      expect(section).toContain('Mode: `merge`')
      expect(put).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews/77', { body: expect.stringContaining('auto-merge enabled') })
    })

    it('uses the merge method from the policy', async () => {
      const { riskDeps, graphql } = deps({ policy: `${mergePolicy}\nmergeMethod: rebase` })
      expect(await riskReview('success', context(), riskDeps)).toContain('with the `rebase` method, from the policy')
      expect(graphql).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'REBASE' }))
    })

    it.each<[string, Fixture, string]>([
      ['the repo does not allow auto-merge', { repoSettings: { allow_auto_merge: false } }, 'the repo does not allow auto-merge'],
      ['the repo reports no merge method', { repoSettings: {} }, 'reported no allowed merge method'],
      ['auto-merge is already on', { autoMerge: { enabled_by: { login: 'dev' } } }, 'already enabled by dev'],
    ])('approves without enabling auto-merge when %s', async (_, fixture, reason) => {
      const { riskDeps, approve, graphql } = deps({ policy: mergePolicy, ...fixture })
      expect(await riskReview('success', context(), riskDeps)).toContain(reason)
      expect(approve).toHaveBeenCalledOnce()
      expect(graphql).not.toHaveBeenCalled()
    })

    it('records why auto-merge could not be enabled', async () => {
      const { riskDeps, graphql } = deps({ policy: mergePolicy })
      graphql.mockRejectedValueOnce(new ReviewError('`gh api graphql` failed: Pull request is in clean status'))
      expect(await riskReview('success', context(), riskDeps)).toContain('auto-merge could not be enabled: `gh api graphql` failed')
    })

    it('dismisses the App approval and disables its auto-merge when a push is no longer low risk', async () => {
      const { riskDeps, appPut, graphql, approve } = deps({
        policy: mergePolicy,
        files: [{ filename: 'src/auth/login.ts' }, { filename: '.github/workflows/ci.yml' }],
        autoMerge: { enabled_by: { login: 'yoke-review[bot]' } },
        reviews: [
          appApproval,
          { ...appApproval, id: 41, state: 'DISMISSED' },
          { ...appApproval, id: 42, user: { login: 'dev' } },
          { id: 77, body: postedBody, state: 'COMMENTED', commit_id: head, user: { login: 'github-actions[bot]' } },
        ],
      })
      const section = await riskReview('success', context(), riskDeps)
      expect(approve).not.toHaveBeenCalled()
      expect(appPut).toHaveBeenCalledOnce()
      expect(appPut).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews/40/dismissals', {
        event: 'DISMISS',
        message: `${head} is no longer low risk; see the Risk section of the review on it.`,
      })
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('disablePullRequestAutoMerge'), { pr: 'PR_5' })
      expect(section).toContain('**Decision:** high risk, needs a human')
      expect(section).toContain('- dismissed the `yoke-review[bot]` approval of `old`, because this head is no longer low risk')
      expect(section).toContain('- disabled the auto-merge `yoke-review[bot]` enabled, because this head is no longer low risk')
    })

    it('withdraws the App approval and auto-merge on a push that was not reviewed, without rating it', async () => {
      const { riskDeps, appPut, graphql, approve } = deps({
        policy: mergePolicy,
        autoMerge: { enabled_by: { login: 'yoke-review[bot]' } },
        reviews: [appApproval],
      })
      const message = await riskReview('skipped', context(), riskDeps)
      expect(approve).not.toHaveBeenCalled()
      expect(appPut).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews/40/dismissals', {
        event: 'DISMISS',
        message: `${head} was pushed after the review and was not reviewed or rated, so it needs a human.`,
      })
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('disablePullRequestAutoMerge'), { pr: 'PR_5' })
      expect(message).toContain(`#5 at ${head} was not reviewed, so it needs a human:`)
      expect(message).toContain('- dismissed the `yoke-review[bot]` approval of `old`, because this push was not reviewed')
    })

    it('reports nothing to withdraw on an unreviewed push the App never approved', async () => {
      const { riskDeps, appPut } = deps({ policy: mergePolicy })
      expect(await riskReview('skipped', context(), riskDeps)).toContain('had no approval or auto-merge to withdraw')
      expect(appPut).not.toHaveBeenCalled()
    })

    it('leaves auto-merge someone else enabled, and records a dismissal that failed', async () => {
      const { riskDeps, appPut, graphql } = deps({
        policy: mergePolicy,
        reviews: [appApproval],
        autoMerge: { enabled_by: { login: 'dev' } },
      })
      appPut.mockRejectedValueOnce(new ReviewError('`gh api` failed: forbidden'))
      const section = await riskReview('failure', context(), riskDeps)
      expect(graphql).not.toHaveBeenCalled()
      expect(section).toContain('the `yoke-review[bot]` approval of `old` could not be dismissed: `gh api` failed: forbidden')
    })
  })

  describe('sampling', () => {
    const samplePolicy = 'lowRisk: ["**/*.md"]\nsample:\n  rate: 0.25'

    it('leaves a sampled low-risk PR for a manual approval and labels it', async () => {
      const { riskDeps, approve } = deps({ policy: samplePolicy, roll: 0.1 })
      const section = await riskReview('success', context(), riskDeps)
      expect(approve).not.toHaveBeenCalledWith('repos/o/r/pulls/5/reviews', expect.anything())
      expect(approve).toHaveBeenCalledWith('repos/o/r/issues/5/labels', { labels: ['yoke-risk-sampled'] })
      expect(section).toContain('**Decision:** low risk, needs a human')
      expect(section).toContain(
        '- sampled for a human check, one of 25% of low-risk PRs: it would otherwise have been approved by `yoke-review`, so it needs a manual approval',
      )
      expect(approve).toHaveBeenCalledOnce()
      expect(section).toContain('**Actions:**\n- labelled `yoke-risk-sampled`')
    })

    it('says a sampled PR would otherwise have been auto-merged in merge mode, and does not enable auto-merge', async () => {
      const { riskDeps, graphql } = deps({ policy: `mode: merge\n${samplePolicy}`, roll: 0 })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('it would otherwise have been approved and auto-merged by `yoke-review`, so it needs a manual approval')
      expect(graphql).not.toHaveBeenCalled()
    })

    it('approves when the roll is above the rate', async () => {
      const { riskDeps, approve } = deps({ policy: samplePolicy, roll: 0.25 })
      expect(await riskReview('success', context(), riskDeps)).not.toContain('sampled')
      expect(approve).toHaveBeenCalledOnce()
      expect(approve).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews', expect.objectContaining({ event: 'APPROVE' }))
    })

    it('keeps a labelled PR for a manual approval on later pushes without labelling or requesting again', async () => {
      const { riskDeps, approve, random } = deps({ policy: `${samplePolicy}\n  label: spot-check`, roll: 0.99, labels: ['spot-check'] })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('already sampled for a human check (labelled `spot-check`): it would otherwise have been approved')
      expect(random).not.toHaveBeenCalled()
      expect(approve).not.toHaveBeenCalled()
    })

    it("withdraws the App's earlier approval and auto-merge when a PR is sampled", async () => {
      const appApproval = { id: 40, body: '## Risk', state: 'APPROVED', commit_id: 'old', user: { login: 'yoke-review[bot]' } }
      const posted = { id: 77, body: postedBody, state: 'COMMENTED', commit_id: head, user: { login: 'github-actions[bot]' } }
      const { riskDeps, graphql } = deps({
        policy: samplePolicy,
        roll: 0,
        reviews: [appApproval, posted],
        autoMerge: { enabled_by: { login: 'yoke-review[bot]' } },
      })
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('- dismissed the `yoke-review[bot]` approval of `old`, because this PR was sampled for a human check')
      expect(section).toContain('- disabled the auto-merge `yoke-review[bot]` enabled, because this PR was sampled for a human check')
      expect(graphql).toHaveBeenCalledOnce()
    })

    it('does not sample a PR that is not approved', async () => {
      const { riskDeps, approve, random } = deps({ policy: samplePolicy, roll: 0, files: [{ filename: '.github/a.md' }] })
      await riskReview('success', context(), riskDeps)
      expect(random).not.toHaveBeenCalled()
      expect(approve).not.toHaveBeenCalled()
    })

    it('records a label GitHub refused', async () => {
      const { riskDeps, approve } = deps({ policy: 'lowRisk: ["**/*.md"]\nsample: { rate: 1 }', roll: 0.99 })
      approve.mockRejectedValueOnce(new ReviewError('`gh api` failed: forbidden'))
      const section = await riskReview('success', context(), riskDeps)
      expect(section).toContain('- the `yoke-risk-sampled` label could not be added: `gh api` failed: forbidden')
    })
  })

  it('records the decision on a failed review too', async () => {
    const failed = '## Code review failed\n\nThe review did not complete.'
    const { riskDeps, put } = deps({
      reviews: [
        {
          id: 9,
          body: failed,
          state: 'COMMENTED',
          commit_id: head,
          user: { login: 'github-actions[bot]' },
        },
      ],
    })
    await riskReview('failure', context(), riskDeps)
    expect(put).toHaveBeenCalledWith('repos/o/r/pulls/5/reviews/9', {
      body: expect.stringMatching(/^## Code review failed[\s\S]*\n\n## Risk\n/),
    })
  })

  it('only logs the decision when no review was posted', async () => {
    const { riskDeps, put, log } = deps({ reviews: [] })
    await riskReview('failure', context(), riskDeps)
    expect(put).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the risk decision is only logged here'))
  })
})

describe('withRiskSection', () => {
  it('replaces an earlier risk section', () => {
    expect(withRiskSection('## Adversarial review\n\nok\n\n## Risk\n\nold', '## Risk\n\nnew')).toBe(
      '## Adversarial review\n\nok\n\n## Risk\n\nnew',
    )
  })
})

describe('appClient', () => {
  it('acts as the App the token belongs to, or none without a token', () => {
    expect(appClient({})).toBeUndefined()
    expect(appClient({ YOKE_REVIEW_APP_TOKEN: 't' })?.login).toBe('yoke-review[bot]')
    expect(appClient({ YOKE_REVIEW_APP_TOKEN: 't', YOKE_REVIEW_APP_SLUG: 'acme-review' })?.login).toBe('acme-review[bot]')
  })
})

describe('runRiskReview', () => {
  it('names itself when run outside GitHub Actions', async () => {
    await expect(runRiskReview('success', () => {}, {})).rejects.toThrow('yoke review risk runs only in a GitHub Actions')
  })

  it('reads the review the same job cached', () => {
    const cache = mkdtempSync(join(tmpdir(), 'risk-'))
    const dir = join(cache, 'yoke', 'reviews', 'o', 'r', `5-${'c'.repeat(40)}-${head}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'review.md'), '## Summary\n\nok\n\n### Finding: bad\n\n- Severity: major\n')
    vi.stubEnv('XDG_CACHE_HOME', cache)
    try {
      const pull = {
        number: 5,
        html_url: 'https://github.com/o/r/pull/5',
        base: { sha: 'c'.repeat(40) },
        head: { sha: head },
      }
      expect(cachedFindings(pull)?.findings.map((f) => f.severity)).toEqual(['major'])
      expect(cachedFindings({ ...pull, number: 6 })).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
