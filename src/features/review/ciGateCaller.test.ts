import { describe, expect, it } from 'vitest'

import { checkCallerWorkflows } from './ciGateCaller'

const job = (uses: string, extra = '') => `jobs:\n  review:\n    uses: ${uses}\n${extra}`
const yokeRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'
const actionsRead = 'permissions:\n  actions: read\n'

function check(content: string, repo = 'o/r') {
  return checkCallerWorkflows([{ path: 'w.yml', content }], repo)
}

describe('checkCallerWorkflows', () => {
  it.each([
    ['a bare pull_request trigger', `on: pull_request\n${actionsRead}${job(yokeRef)}`],
    ['a trigger list', `on: [push, pull_request]\n${actionsRead}${job(yokeRef)}`],
    ['a trigger without types', `on:\n  pull_request:\n${actionsRead}${job(yokeRef)}`],
    ['a single synchronize type', `on:\n  pull_request:\n    types: synchronize\n${actionsRead}${job(yokeRef)}`],
    ['job-level permissions', `on: pull_request\n${job(yokeRef, '    permissions:\n      actions: write\n')}`],
    ['read-all permissions', `on: pull_request\npermissions: read-all\n${job(yokeRef)}`],
    ['another ref of review.yml', `on: pull_request\n${actionsRead}${job('makerxstudio/yoke/.github/workflows/review.yml@v1')}`],
  ])('accepts %s', (_, content) => {
    expect(check(content)).toEqual({ path: 'w.yml', missing: [] })
  })

  it('accepts the local review.yml only in yoke itself', () => {
    const content = `on: pull_request\n${actionsRead}${job('./.github/workflows/review.yml')}`
    expect(check(content, 'MakerXStudio/yoke')).toEqual({ path: 'w.yml', missing: [] })
    expect(check(content)).toBeUndefined()
  })

  it.each([
    ['no pull_request trigger', `on: push\n${actionsRead}${job(yokeRef)}`],
    ['a pull_request_target trigger', `on:\n  pull_request_target:\n${actionsRead}${job(yokeRef)}`],
  ])('reports the missing synchronize trigger with %s', (_, content) => {
    expect(check(content)?.missing).toEqual(['the `synchronize` type in its `pull_request` trigger'])
  })

  it.each([
    ['no permissions', `on: pull_request\n${job(yokeRef)}`],
    ['actions: none', `on: pull_request\npermissions:\n  actions: none\n${job(yokeRef)}`],
    [
      'job permissions overriding workflow ones',
      `on: pull_request\n${actionsRead}${job(yokeRef, '    permissions:\n      contents: read\n')}`,
    ],
  ])('reports missing actions: read with %s', (_, content) => {
    expect(check(content)?.missing).toEqual(['`actions: read` in its permissions'])
  })

  it('prefers a complete caller over an incomplete one', () => {
    const files = [
      { path: 'bad.yml', content: `on: push\n${job(yokeRef)}` },
      { path: 'good.yml', content: `on: pull_request\n${actionsRead}${job(yokeRef)}` },
    ]
    expect(checkCallerWorkflows(files, 'o/r')).toEqual({ path: 'good.yml', missing: [] })
  })

  it('skips unparseable and unrelated workflows', () => {
    const files = [
      { path: 'broken.yml', content: 'on: [' },
      { path: 'list.yml', content: '- a' },
      { path: 'ci.yml', content: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n  empty:\n' },
    ]
    expect(checkCallerWorkflows(files, 'o/r')).toBeUndefined()
  })
})
