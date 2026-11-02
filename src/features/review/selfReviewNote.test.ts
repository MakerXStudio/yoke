import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

const reusable = z
  .object({ jobs: z.object({ review: z.object({ if: z.string() }) }) })
  .parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/workflows/review.yml'), 'utf8')))

describe('selfReviewNote', () => {
  it('rests the deliberate missing concurrency block on the reusable review job skipping synchronize events', () => {
    expect(reusable.jobs.review.if).toContain("github.event.action != 'synchronize' &&")
  })
})
