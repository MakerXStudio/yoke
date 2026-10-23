import { describe, expect, it } from 'vitest'

import { raiseGuide } from './guide'

const lines = raiseGuide.split('\n')

describe('raiseGuide', () => {
  it('ends the heredoc on a flush-left EOF', () => {
    expect(lines).toContain('EOF')
  })

  it('starts body headings flush-left', () => {
    expect(lines).toContain('## What')
  })
})
