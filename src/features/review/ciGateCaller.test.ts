import { describe, expect, it } from 'vitest'

import { checkCallerWorkflows } from './ciGateCaller'

const job = (uses: string, extra = '') => `jobs:\n  review:\n    uses: ${uses}\n${extra}`
const yokeRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'
const actionsRead = 'permissions:\n  actions: read\n'

function check(content: string, repo = 'o/r') {
  return checkCallerWorkflows([{ path: 'w.yml', content }], repo, 'main')
}

const filtered = (filter: string) => `on:\n  pull_request:\n${filter}${actionsRead}${job(yokeRef)}`

describe('checkCallerWorkflows', () => {
  it.each([
    ['a bare pull_request trigger', `on: pull_request\n${actionsRead}${job(yokeRef)}`],
    ['a trigger list', `on: [push, pull_request]\n${actionsRead}${job(yokeRef)}`],
    ['a trigger without types', `on:\n  pull_request:\n${actionsRead}${job(yokeRef)}`],
    ['a single synchronize type', `on:\n  pull_request:\n    types: synchronize\n${actionsRead}${job(yokeRef)}`],
    ['job-level permissions', `on: pull_request\n${job(yokeRef, '    permissions:\n      actions: write\n')}`],
    ['read-all permissions', `on: pull_request\npermissions: read-all\n${job(yokeRef)}`],
    ['another ref of review.yml', `on: pull_request\n${actionsRead}${job('makerxstudio/yoke/.github/workflows/review.yml@v1')}`],
    ['a branches filter naming the default branch', filtered('    branches: [main]\n')],
    ['a branches glob matching the default branch', filtered("    branches: ['**']\n")],
    ['a branches-ignore filter that spares the default branch', filtered("    branches-ignore: ['release/*']\n")],
  ])('accepts %s', (_, content) => {
    expect(check(content)).toEqual({ path: 'w.yml', problems: [] })
  })

  it('accepts the local review.yml only in yoke itself', () => {
    const content = `on: pull_request\n${actionsRead}${job('./.github/workflows/review.yml')}`
    expect(check(content, 'MakerXStudio/yoke')).toEqual({ path: 'w.yml', problems: [] })
    expect(check(content)).toBeUndefined()
  })

  it.each([
    ['no pull_request trigger', `on: push\n${actionsRead}${job(yokeRef)}`],
    ['a pull_request_target trigger', `on:\n  pull_request_target:\n${actionsRead}${job(yokeRef)}`],
  ])('reports the missing synchronize trigger with %s', (_, content) => {
    expect(check(content)?.problems).toEqual(['lacks the `synchronize` type in its `pull_request` trigger'])
  })

  it.each([
    ['paths', filtered("    paths: ['src/**']\n"), '`paths`'],
    ['paths-ignore', filtered("    paths-ignore: ['docs/**']\n"), '`paths-ignore`'],
    ['branches without the default branch', filtered('    branches: [develop]\n'), '`branches`'],
    ['branches negating the default branch', filtered("    branches: ['**', '!main']\n"), '`branches`'],
    ['branches-ignore matching the default branch', filtered("    branches-ignore: ['ma*']\n"), '`branches-ignore`'],
    ['paths and branches', filtered("    branches: [develop]\n    paths: ['src/**']\n"), '`paths`, `branches` filters'],
  ])('reports a %s filter that skips PRs to the default branch', (_, content, filters) => {
    const named = filters.endsWith('filters') ? filters : `${filters} filter`
    expect(check(content)?.problems).toEqual([
      `skips some PRs to main through its \`pull_request\` ${named}, so those PRs could never merge`,
    ])
  })

  it.each([
    ['no permissions', `on: pull_request\n${job(yokeRef)}`],
    ['actions: none', `on: pull_request\npermissions:\n  actions: none\n${job(yokeRef)}`],
    [
      'job permissions overriding workflow ones',
      `on: pull_request\n${actionsRead}${job(yokeRef, '    permissions:\n      contents: read\n')}`,
    ],
  ])('reports missing actions: read with %s', (_, content) => {
    expect(check(content)?.problems).toEqual(['lacks `actions: read` in its permissions'])
  })

  it('prefers a complete caller over an incomplete one', () => {
    const files = [
      { path: 'bad.yml', content: `on: push\n${job(yokeRef)}` },
      { path: 'good.yml', content: `on: pull_request\n${actionsRead}${job(yokeRef)}` },
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
