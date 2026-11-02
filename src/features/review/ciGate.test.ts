import { describe, expect, it } from 'vitest'

import { enforceReviewGate, type GateApi } from './ciGate'
import { ReviewError } from './pr'

type Rule = { type: string; ruleset_id?: number; parameters?: { required_status_checks?: { context: string }[] } }

const gateRule: Rule = {
  type: 'required_status_checks',
  ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'review / gate' }] },
}

const callerYaml = `name: Review PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  actions: read
  contents: read
  pull-requests: write
jobs:
  review:
    uses: MakerXStudio/yoke/.github/workflows/review.yml@main
`

const checkRunsPath = (sha: string) => `repos/o/r/commits/${sha}/check-runs?check_name=review%20%2F%20gate&per_page=1`

type FakeOptions = {
  admin?: boolean
  rules?: Rule[]
  workflows?: Record<string, string> | null
  gateShas?: string[]
  rulesets?: { id: number; name: string; enforcement: string }[]
}

function fakeApi({
  admin = true,
  rules = [],
  workflows = { 'review-pr.yml': callerYaml },
  gateShas = ['b'],
  rulesets = [{ id: 3, name: 'protect main', enforcement: 'active' }],
}: FakeOptions = {}) {
  const gets: string[] = []
  const posts: [string, unknown][] = []
  const responses = new Map<string, unknown>([
    ['repos/{owner}/{repo}', { full_name: 'o/r', html_url: 'https://github.com/o/r', default_branch: 'main', permissions: { admin } }],
    ['repos/o/r/rules/branches/main', rules],
    ['repos/o/r/rulesets?includes_parents=false&per_page=100', rulesets],
    ['repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=20', ['a', 'b'].map((sha) => ({ head: { sha } }))],
    ...['a', 'b'].map((sha) => [checkRunsPath(sha), { total_count: gateShas.includes(sha) ? 1 : 0 }] as const),
  ])
  if (workflows) {
    responses.set('repos/o/r/contents/.github/workflows?ref=main', [
      { type: 'dir', name: 'nested', path: '.github/workflows/nested' },
      ...Object.keys(workflows).map((name) => ({ type: 'file', name, path: `.github/workflows/${name}` })),
    ])
    for (const [name, content] of Object.entries(workflows))
      responses.set(`repos/o/r/contents/.github/workflows/${name}?ref=main`, { content: Buffer.from(content).toString('base64') })
  }
  const api: GateApi = {
    get: async (path) => {
      gets.push(path)
      if (responses.has(path)) return responses.get(path)
      throw new ReviewError(`\`gh api ${path}\` failed: gh: Not Found (HTTP 404)`)
    },
    post: async (path, body) => {
      posts.push([path, body])
      return { id: 42 }
    },
  }
  return Object.assign(api, { gets, posts })
}

async function expectRefused(api: ReturnType<typeof fakeApi>, ...messages: string[]) {
  const failure = enforceReviewGate(api)
  await expect(failure).rejects.toThrow(ReviewError)
  for (const message of messages) await expect(failure).rejects.toThrow(message)
  expect(api.posts).toEqual([])
}

describe('enforceReviewGate', () => {
  it('creates a ruleset requiring review / gate on the default branch', async () => {
    const api = fakeApi()
    const outcome = await enforceReviewGate(api)
    expect(api.posts).toEqual([
      [
        'repos/o/r/rulesets',
        {
          name: 'yoke review',
          target: 'branch',
          enforcement: 'active',
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          rules: [
            {
              type: 'required_status_checks',
              parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'review / gate' }] },
            },
          ],
        },
      ],
    ])
    expect(outcome.created).toBe(true)
    expect(outcome.message).toContain('blocks merging to main until review / gate passes: https://github.com/o/r/rules/42')
  })

  it('reports already enforced and changes nothing when a ruleset already requires review / gate', async () => {
    const api = fakeApi({ rules: [{ type: 'pull_request' }, gateRule] })
    const outcome = await enforceReviewGate(api)
    expect(api.posts).toEqual([])
    expect(outcome).toEqual({
      created: false,
      message: 'review / gate is already required on main by https://github.com/o/r/rules/7; nothing changed.',
    })
  })

  it('reports already enforced even when the user cannot manage rulesets', async () => {
    const api = fakeApi({ admin: false, rules: [gateRule] })
    expect((await enforceReviewGate(api)).created).toBe(false)
    expect(api.posts).toEqual([])
  })

  it('creates the ruleset when other status checks are required but not review / gate', async () => {
    const api = fakeApi({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }] })
    expect((await enforceReviewGate(api)).created).toBe(true)
    expect(api.posts).toHaveLength(1)
  })

  it('creates nothing and names the fix when the gh user cannot manage rulesets', async () => {
    await expectRefused(
      fakeApi({ admin: false }),
      'Cannot require review / gate on main yet:',
      "Your gh user can't manage o/r's rulesets",
      'Ask a repo admin to run `yoke review-ci-gate`',
    )
  })

  it('creates nothing and links an inactive yoke review ruleset instead of posting a duplicate', async () => {
    await expectRefused(
      fakeApi({ rulesets: [{ id: 9, name: 'yoke review', enforcement: 'disabled' }] }),
      'The "yoke review" ruleset already exists with enforcement `disabled` but doesn\'t require review / gate on main: https://github.com/o/r/rules/9. Set its enforcement to Active',
    )
  })

  it('creates nothing when the default branch has no workflows directory', async () => {
    await expectRefused(fakeApi({ workflows: null }), "No workflow on main calls yoke's review.yml. Run /review-ci")
  })

  it('creates nothing when no default-branch workflow calls review.yml', async () => {
    await expectRefused(
      fakeApi({ workflows: { 'ci.yml': 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n' } }),
      "No workflow on main calls yoke's review.yml",
      'merge its .github/workflows/review-pr.yml to main',
    )
  })

  it('creates nothing when the caller lacks the synchronize trigger', async () => {
    await expectRefused(
      fakeApi({ workflows: { 'review-pr.yml': callerYaml.replace('synchronize, ', '') } }),
      ".github/workflows/review-pr.yml on main calls yoke's review.yml but lacks the `synchronize` type in its `pull_request` trigger.",
    )
  })

  it('creates nothing when the caller lacks actions: read', async () => {
    await expectRefused(
      fakeApi({ workflows: { 'review-pr.yml': callerYaml.replace('  actions: read\n', '') } }),
      'lacks `actions: read` in its permissions. Fix it and merge the change to main.',
    )
  })

  it('creates nothing when the caller has a paths filter', async () => {
    await expectRefused(
      fakeApi({ workflows: { 'review-pr.yml': callerYaml.replace('ready_for_review]\n', "ready_for_review]\n    paths: ['src/**']\n") } }),
      "calls yoke's review.yml but skips some PRs to main through its `pull_request` `paths` filter, so those PRs could never merge.",
    )
  })

  it('creates nothing and says to update a PR when no review / gate check run exists', async () => {
    const api = fakeApi({ gateShas: [] })
    await expectRefused(api, 'No review / gate check run on the 20 most recently updated PRs. Open or push to a PR so the gate reports')
    expect(api.gets).toContain(checkRunsPath('b'))
  })

  it('stops looking for check runs once one PR has the gate', async () => {
    const api = fakeApi({ gateShas: ['a'] })
    await enforceReviewGate(api)
    expect(api.gets).not.toContain(checkRunsPath('b'))
  })

  it('lists every problem at once', async () => {
    await expectRefused(
      fakeApi({ admin: false, workflows: null, gateShas: [] }),
      "can't manage",
      'No workflow',
      'No review / gate check run',
    )
  })

  it('rethrows API failures other than a missing workflows directory', async () => {
    const api = fakeApi()
    api.get = async (path) => {
      if (path.startsWith('repos/o/r/contents')) throw new ReviewError('gh: Bad credentials (HTTP 401)')
      return fakeApi().get(path)
    }
    await expectRefused(api, 'Bad credentials')
  })
})
