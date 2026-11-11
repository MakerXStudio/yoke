import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runReviewGate } from './features/review/gate'
import { runPushReview } from './features/review/pushReview'
import { runUnapproveReview } from './features/review/unapprove'
import { addLockedWorkflowAliases, addReviewCiCommands } from './reviewCiCommands'

vi.mock('./features/review/gate', () => ({ runReviewGate: vi.fn(async () => true) }))
vi.mock('./features/review/pushReview', () => ({ runPushReview: vi.fn(async () => {}) }))
vi.mock('./features/review/unapprove', () => ({ runUnapproveReview: vi.fn(async () => {}) }))

function cli(): Command {
  const program = new Command('yoke').exitOverride().enablePositionalOptions()
  const review = program
    .command('review')
    .argument('[number]')
    .action(() => {})
  addReviewCiCommands(review)
  addLockedWorkflowAliases(program)
  return program
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('review commands', () => {
  it.each([[['review', 'gate', 'success']], [['review-gate', 'success']]])('runs the gate for %j', async (argv) => {
    await cli().parseAsync(argv, { from: 'user' })
    expect(runReviewGate).toHaveBeenCalledWith('success', expect.any(Function))
  })

  it.each([[['review', 'unapprove']], [['review-unapprove']]])('removes the approval for %j', async (argv) => {
    await cli().parseAsync(argv, { from: 'user' })
    expect(runUnapproveReview).toHaveBeenCalledWith(expect.any(Function))
  })

  it('decides whether a push runs the review', async () => {
    await cli().parseAsync(['review-push'], { from: 'user' })
    expect(runPushReview).toHaveBeenCalledWith(expect.any(Function))
  })

  it("keeps the locked yoke's review.yml commands out of yoke's help", () => {
    const help = cli().helpInformation()
    expect(help).not.toContain('review-gate')
    expect(help).not.toContain('review-unapprove')
    expect(help).not.toContain('review-push')
  })
})
