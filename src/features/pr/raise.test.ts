import { describe, expect, it, vi } from 'vitest'

import { PrValidationError, raisePr } from './raise'

const title = 'feat(retake): confirm before resetting'
const body = '## What\n\nRetake asks for confirmation.\n\n## Why\n\nResults were lost by accident.\n'

describe('raisePr', () => {
  it('creates a draft PR with gh and returns its URL', () => {
    const run = vi.fn(() => 'Creating draft pull request\nhttps://github.com/o/r/pull/7\n')
    expect(raisePr({ title, body, draft: true }, run)).toBe('https://github.com/o/r/pull/7')
    expect(run).toHaveBeenCalledWith(['pr', 'create', '--title', title, '--body', body.trim(), '--draft'])
  })

  it('passes the base branch and omits --draft when asked', () => {
    const run = vi.fn(() => 'https://github.com/o/r/pull/8')
    raisePr({ title, body, base: 'develop', draft: false }, run)
    expect(run).toHaveBeenCalledWith(['pr', 'create', '--title', title, '--body', body.trim(), '--base', 'develop'])
  })

  it('does not call gh when validation fails', () => {
    const run = vi.fn(() => '')
    expect(() => raisePr({ title, body: '## What\n\nOnly what.', draft: true }, run)).toThrow(PrValidationError)
    expect(run).not.toHaveBeenCalled()
  })

  it('names the failed rule in the error message', () => {
    expect(() => raisePr({ title, body: '## What\n\nOnly what.', draft: true }, vi.fn())).toThrow(/why-required/)
  })
})
