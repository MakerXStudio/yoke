import { describe, expect, it, vi } from 'vitest'

import { ciRunUrl, isCi, reportFailure, warnIgnoredYokeVersion, yokeVersionWarning } from './ciRun'
import type { PostDeps } from './post'
import type { PullRequest } from './request'
import { lineUi } from './status'

describe('isCi', () => {
  it('is true only when GITHUB_ACTIONS is "true"', () => {
    expect(isCi({ GITHUB_ACTIONS: 'true' })).toBe(true)
    expect(isCi({})).toBe(false)
  })
})

describe('ciRunUrl', () => {
  const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' }

  it('links the workflow run', () => {
    expect(ciRunUrl(env)).toBe('https://github.com/o/r/actions/runs/9')
  })

  it.each(Object.keys(env))('is undefined without %s', (key) => {
    expect(ciRunUrl({ ...env, [key]: '' })).toBeUndefined()
  })
})

function fakeApi(submit: PostDeps['api']['submit']): PostDeps['api'] {
  return { open: async () => ({ id: 7, nodeId: 'PRR_7' }), add: async () => {}, submit, discard: async () => {} }
}

describe('reportFailure', () => {
  const pr: PullRequest = {
    number: 4,
    url: 'https://github.com/o/r/pull/4',
    title: 't',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: 'feature',
    headRefOid: 'head',
    files: [],
  }

  it('posts the failed review', async () => {
    const logs: string[] = []
    const submit = vi.fn<PostDeps['api']['submit']>(async () => 'https://github.com/o/r/pull/4#pullrequestreview-7')
    const log = (line: string) => logs.push(line)
    await reportFailure(pr, 'reviewer 2 failed', lineUi(log, { activity: false }), { api: fakeApi(submit), log })
    expect(submit).toHaveBeenCalledOnce()
    expect(logs).toContain('posted the failed review: https://github.com/o/r/pull/4#pullrequestreview-7')
  })

  it('logs a posting error instead of throwing it', async () => {
    const logs: string[] = []
    const log = (line: string) => logs.push(line)
    const api = fakeApi(async () => {
      throw new Error('forbidden')
    })
    await expect(reportFailure(pr, 'reviewer 2 failed', lineUi(log, { activity: false }), { api, log })).resolves.toBeUndefined()
    expect(logs).toContain('could not post the failed review: forbidden')
  })
})

describe('yokeVersionWarning', () => {
  it('warns that a set yoke-version is ignored', () => {
    const warning = yokeVersionWarning({ YOKE_VERSION_INPUT: '0.12.0' })
    expect(warning).toMatch(/^::warning::/)
    expect(warning).toContain('yoke-version input (0.12.0) is deprecated and ignored')
  })

  it.each([undefined, '', '  '])('stays quiet when yoke-version is %j', (value) => {
    expect(yokeVersionWarning({ YOKE_VERSION_INPUT: value })).toBeUndefined()
  })
})

describe('warnIgnoredYokeVersion', () => {
  it('prints the warning only when yoke-version is set', () => {
    const out = vi.fn()
    warnIgnoredYokeVersion(out, {})
    expect(out).not.toHaveBeenCalled()
    warnIgnoredYokeVersion(out, { YOKE_VERSION_INPUT: 'latest' })
    expect(out).toHaveBeenCalledWith(expect.stringMatching(/^::warning::The yoke-version input \(latest\)/))
  })
})
