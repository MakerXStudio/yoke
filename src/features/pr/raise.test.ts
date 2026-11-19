import { describe, expect, it, vi } from 'vitest'

import { PrBodyError, PrValidationError, raisePr, readBody } from './raise'

const title = 'feat(retake): confirm before resetting'
const failingRead = () => {
  throw new Error('ENOENT: no such file or directory')
}
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

describe('readBody', () => {
  it('returns --body unchanged', () => {
    const read = vi.fn(() => '')
    expect(readBody({ body }, read)).toBe(body)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the body from a file path', () => {
    const read = vi.fn(() => body)
    expect(readBody({ bodyFile: 'body.md' }, read)).toBe(body)
    expect(read).toHaveBeenCalledWith('body.md')
  })

  it('hands - to the reader for stdin', () => {
    const read = vi.fn(() => body)
    expect(readBody({ bodyFile: '-' }, read)).toBe(body)
    expect(read).toHaveBeenCalledWith('-')
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(readBody({ bodyFile: 'body.md' }, () => `\uFEFF${body}`)).toBe(body)
  })

  it('reports an unreadable file as a PrBodyError naming the path', () => {
    expect(() => readBody({ bodyFile: 'missing.md' }, failingRead)).toThrow(PrBodyError)
    expect(() => readBody({ bodyFile: 'missing.md' }, failingRead)).toThrow(/missing.md: ENOENT/)
  })

  it('requires --body or --body-file', () => {
    expect(() => readBody({}, vi.fn())).toThrow(PrBodyError)
  })
})
