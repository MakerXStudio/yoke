import { describe, expect, it, vi } from 'vitest'

import { ReviewError } from './pr'
import { type ReportDeps, riskReport, runRiskReport } from './riskReport'

const risk = (decision: string, actions = '') =>
  `## Adversarial review\n\nok\n\n## Risk\n\n**Decision:** ${decision}\n\n- reason${actions ? `\n\n**Actions:**\n- ${actions}` : ''}`

const bot = { login: 'github-actions[bot]', type: 'Bot' }
const person = (login: string) => ({ login, type: 'User' })

function deps(policy: string | null = 'sample:\n  rate: 0.5\n  label: spot'): ReportDeps & { get: ReturnType<typeof vi.fn> } {
  const reviews: Record<number, unknown[]> = {
    1: [
      { body: risk('low risk, needs a human'), state: 'COMMENTED', user: bot },
      { body: 'lgtm', state: 'APPROVED', user: person('alice') },
    ],
    2: [
      { body: risk('low risk, needs a human', 'sampled for a human check, one of 50%'), state: 'COMMENTED', user: bot },
      { body: '', state: 'APPROVED', user: person('dev') },
      { body: 'no', state: 'CHANGES_REQUESTED', user: person('bob') },
    ],
    3: [{ body: risk('low risk, approved by `yoke-review`'), state: 'COMMENTED', user: bot }],
    4: [{ body: '## Adversarial review\n\nno risk section', state: 'COMMENTED', user: bot }],
    5: [
      { body: risk('low risk, needs a human'), state: 'COMMENTED', user: bot },
      { body: 'hmm', state: 'COMMENTED', user: person('carol') },
    ],
  }
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === 'repos/o/r') return { default_branch: 'main' }
    if (path === 'repos/o/r/contents/.github/yoke-risk.yml?ref=main') {
      if (policy === null) throw new Error('gh: Not Found (HTTP 404)')
      return { content: Buffer.from(policy).toString('base64'), html_url: 'u' }
    }
    if (path.startsWith('repos/o/r/commits?')) return [{ sha: 'p' }]
    if (path === 'repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=30')
      return [
        { number: 1, state: 'closed', merged_at: '2026-11-01T00:00:00Z', user: person('dev'), labels: [{ name: 'spot' }] },
        { number: 2, state: 'open', merged_at: null, user: person('dev'), labels: [] },
        { number: 3, state: 'open', merged_at: null, user: person('dev'), labels: [] },
        { number: 4, state: 'closed', merged_at: null, user: person('dev'), labels: [] },
        { number: 5, state: 'open', merged_at: null, user: person('dev'), labels: [{ name: 'spot' }] },
      ]
    throw new Error(`unexpected GET ${path}`)
  })
  const paginate = vi.fn(async (path: string): Promise<unknown[]> => {
    const number = Number(/pulls\/(\d+)\/reviews/.exec(path)?.[1])
    return reviews[number] ?? []
  })
  return { get, paginate }
}

describe('riskReport', () => {
  it("lists each risk decision and each sampled PR's human verdict", async () => {
    expect(await riskReport('o/r', 30, deps())).toBe(
      [
        'o/r: 4 of the 5 most recently updated PRs have a risk decision; 1 auto-approved, 3 sampled (1 approved, 1 changes requested, 1 without a verdict)',
        '  #1 merged: low risk, needs a human · sampled: approved by alice',
        '  #2 open: low risk, needs a human · sampled: changes requested by bob',
        '  #3 open: low risk, approved by yoke-review',
        '  #5 open: low risk, needs a human · sampled: commented, no verdict yet',
      ].join('\n'),
    )
  })

  it('notes a repo with no policy and uses the default label', async () => {
    const report = await riskReport('o/r', 30, deps(null))
    expect(report).toContain('  note: no .github/yoke-risk.yml on the default branch, so risk review is off')
    expect(report).toContain('1 sampled')
  })

  it('notes an invalid policy', async () => {
    expect(await riskReport('o/r', 30, deps('mode: yolo'))).toContain('  note: .github/yoke-risk.yml is invalid')
  })
})

describe('runRiskReport', () => {
  it('reports each repo', async () => {
    const out = vi.fn()
    await runRiskReport(['o/r'], 30, out, deps())
    expect(out).toHaveBeenCalledWith(expect.stringMatching(/^o\/r: 4 of the 5/))
  })

  it.each<[string[], number, string]>([
    [['o/r'], 0, '--limit must be a whole number from 1 to 100'],
    [['o/r'], Number.NaN, '--limit must be'],
    [['<owner>/<repo>'], 30, '<owner>/<repo> is not an owner/repo'],
  ])('rejects %j with limit %d', async (repos, limit, message) => {
    await expect(runRiskReport(repos, limit, () => {}, deps())).rejects.toThrow(new ReviewError(message).message)
  })
})
