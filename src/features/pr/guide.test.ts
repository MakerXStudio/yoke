import { describe, expect, it } from 'vitest'

import { raiseGuide } from './guide'

const lines = raiseGuide.split('\n')

describe('raiseGuide', () => {
  it('ends the heredoc on a flush-left EOF', () => {
    expect(lines).toContain('EOF')
  })

  it('passes the body by file, never as a --body argument', () => {
    expect(raiseGuide).toContain('--body-file <path>')
    expect(raiseGuide).toContain('--body-file - <<')
    expect(raiseGuide).not.toContain('--body "')
  })

  it('starts body headings flush-left', () => {
    expect(lines).toContain('## What')
  })
})
