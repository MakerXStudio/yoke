import { describe, expect, it } from 'vitest'

import { checkCallerWorkflows } from './ciGateCaller'

const job = (uses: string, extra = '') => `jobs:\n  review:\n    uses: ${uses}\n${extra}`
const yokeRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'
const writes = 'permissions:\n  actions: write\n  statuses: write\n'
const target = '  pull_request_target:\n    types: [labeled, synchronize]\n'
const labelProblem = 'lacks a `pull_request_target` trigger with the `labeled` type, so fork PRs can never pass the gate'

function check(content: string, repo = 'o/r') {
  return checkCallerWorkflows([{ path: 'w.yml', content }], repo, 'main')
}

const caller = (pullRequest = '  pull_request:\n') => `on:\n${pullRequest}${target}${writes}${job(yokeRef)}`

const filtered = (filter: string) => caller(`  pull_request:\n${filter}`)

describe('checkCallerWorkflows', () => {
  it.each([
    ['a trigger without types', caller()],
    ['a single synchronize type', caller('  pull_request:\n    types: synchronize\n')],
    [
      'job-level permissions',
      `on:\n  pull_request:\n${target}${job(yokeRef, '    permissions:\n      actions: write\n      statuses: write\n')}`,
    ],
    ['write-all permissions', `on:\n  pull_request:\n${target}permissions: write-all\n${job(yokeRef)}`],
    ['another ref of review.yml', `on:\n  pull_request:\n${target}${writes}${job('makerxstudio/yoke/.github/workflows/review.yml@v1')}`],
    ['a branches filter naming the default branch', filtered('    branches: [main]\n')],
    ['a branches glob matching the default branch', filtered("    branches: ['**']\n")],
    ['a branches-ignore filter that spares the default branch', filtered("    branches-ignore: ['release/*']\n")],
    [
      'a pull_request_target branches filter naming the default branch',
      `on:\n  pull_request:\n  pull_request_target:\n    types: [labeled, synchronize]\n    branches: [main]\n${writes}${job(yokeRef)}`,
    ],
  ])('accepts %s', (_, content) => {
    expect(check(content)).toEqual({ path: 'w.yml', problems: [] })
  })

  it('accepts the local review.yml only in yoke itself', () => {
    const content = `on:\n  pull_request:\n${target}${writes}${job('./.github/workflows/review.yml')}`
    expect(check(content, 'MakerXStudio/yoke')).toEqual({ path: 'w.yml', problems: [] })
    expect(check(content)).toBeUndefined()
  })

  it.each([
    ['no pull_request trigger', `on:\n  push:\n${target}${writes}${job(yokeRef)}`],
    ['types without synchronize', caller('  pull_request:\n    types: [opened]\n')],
  ])('reports the missing synchronize trigger with %s', (_, content) => {
    expect(check(content)?.problems).toEqual(['lacks the `synchronize` type in its `pull_request` trigger'])
  })

  it.each([
    ['a bare pull_request trigger', `on: pull_request\n${writes}${job(yokeRef)}`],
    ['a trigger list without types', `on: [pull_request, pull_request_target]\n${writes}${job(yokeRef)}`],
    ['a pull_request_target trigger without types', `on:\n  pull_request:\n  pull_request_target:\n${writes}${job(yokeRef)}`],
    ['types without labeled', `on:\n  pull_request:\n  pull_request_target:\n    types: [opened]\n${writes}${job(yokeRef)}`],
  ])('reports the missing labeled trigger with %s', (_, content) => {
    expect(check(content)?.problems).toEqual([labelProblem])
  })

  it('reports a pull_request_target trigger that lacks synchronize', () => {
    const content = `on:\n  pull_request:\n  pull_request_target:\n    types: [labeled]\n${writes}${job(yokeRef)}`
    expect(check(content)?.problems).toEqual([
      "lacks the `synchronize` type in its `pull_request_target` trigger, so a push to an approved fork PR keeps the `review` label and a maintainer can't re-approve it",
    ])
  })

  it.each([
    ['paths', filtered("    paths: ['src/**']\n"), '`pull_request` `paths`'],
    ['paths-ignore', filtered("    paths-ignore: ['docs/**']\n"), '`pull_request` `paths-ignore`'],
    ['branches without the default branch', filtered('    branches: [develop]\n'), '`pull_request` `branches`'],
    ['branches negating the default branch', filtered("    branches: ['**', '!main']\n"), '`pull_request` `branches`'],
    ['branches-ignore matching the default branch', filtered("    branches-ignore: ['ma*']\n"), '`pull_request` `branches-ignore`'],
    ['paths and branches', filtered("    branches: [develop]\n    paths: ['src/**']\n"), '`pull_request` `paths`, `branches` filters'],
    [
      'pull_request_target branches',
      `on:\n  pull_request:\n  pull_request_target:\n    types: [labeled, synchronize]\n    branches: [develop]\n${writes}${job(yokeRef)}`,
      '`pull_request_target` `branches`',
    ],
  ])('reports a %s filter that skips PRs to the default branch', (_, content, filters) => {
    const named = filters.endsWith('filters') ? filters : `${filters} filter`
    expect(check(content)?.problems).toEqual([`skips some PRs to main through its ${named}, so those PRs could never merge`])
  })

  it.each([
    ['no permissions', `on:\n  pull_request:\n${target}${job(yokeRef)}`, '`actions: write` and `statuses: write`'],
    [
      'read-all permissions',
      `on:\n  pull_request:\n${target}permissions: read-all\n${job(yokeRef)}`,
      '`actions: write` and `statuses: write`',
    ],
    [
      'actions: read',
      `on:\n  pull_request:\n${target}permissions:\n  actions: read\n  statuses: write\n${job(yokeRef)}`,
      '`actions: write`',
    ],
    ['no statuses', `on:\n  pull_request:\n${target}permissions:\n  actions: write\n${job(yokeRef)}`, '`statuses: write`'],
    [
      'job permissions overriding workflow ones',
      `on:\n  pull_request:\n${target}${writes}${job(yokeRef, '    permissions:\n      contents: read\n')}`,
      '`actions: write` and `statuses: write`',
    ],
  ])('reports missing write permissions with %s', (_, content, missing) => {
    expect(check(content)?.problems).toEqual([`lacks ${missing} in its permissions`])
  })

  it('prefers a complete caller over an incomplete one', () => {
    const files = [
      { path: 'bad.yml', content: `on: push\n${job(yokeRef)}` },
      { path: 'good.yml', content: caller() },
    ]
    expect(checkCallerWorkflows(files, 'o/r', 'main')).toEqual({ path: 'good.yml', problems: [] })
  })

  it('skips unparseable and unrelated workflows', () => {
    const files = [
      { path: 'broken.yml', content: 'on: [' },
      { path: 'list.yml', content: '- a' },
      { path: 'ci.yml', content: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n  empty:\n' },
    ]
    expect(checkCallerWorkflows(files, 'o/r', 'main')).toBeUndefined()
  })
})
