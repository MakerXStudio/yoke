import { describe, expect, it } from 'vitest'

import { buildReviewerPrompt } from './prompts'

describe('buildReviewerPrompt', () => {
  const prompt = buildReviewerPrompt('/review/request.md')

  it('tells the reviewer which commits are available and which git commands it may run', () => {
    expect(prompt).toContain('The base and head commits named in the request, and their merge base, are available')
    expect(prompt).not.toContain('full git history')
    for (const command of ['`git log`', '`git blame`', '`git diff <base>...<head>`']) expect(prompt).toContain(command)
  })

  it('forbids git commands that change the repository', () => {
    expect(prompt).toContain('Do not run any git command that changes the repository')
  })

  it('names the request file', () => {
    expect(prompt).toContain('The review request is at: /review/request.md')
  })
})
