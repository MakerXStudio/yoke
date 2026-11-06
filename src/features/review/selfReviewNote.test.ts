import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

import { selfReviewNote } from './selfReviewNote'

const reviewYml = readFileSync(join(import.meta.dirname, '../../../.github/workflows/review.yml'), 'utf8')
const reusable = z.object({ jobs: z.object({ review: z.object({ if: z.string() }) }) }).parse(parse(reviewYml))

const callerDiff = `diff --git a/.github/workflows/review-ci.yml b/.github/workflows/review-ci.yml
--- a/.github/workflows/review-ci.yml
+++ b/.github/workflows/review-ci.yml
@@ -1,1 +1,1 @@
-    runs-on: ubuntu-latest
+    uses: MakerXStudio/yoke/.github/workflows/review.yml@review-v0.17.1
`

describe('selfReviewNote', () => {
  it('tells the reviewer an OIDC caller needs no API key secret, as the reusable workflow ignores it there', () => {
    expect(selfReviewNote(callerDiff)).toContain('Not passing `REVIEW_CI_API_KEY` from a caller that passes `azure-client-id`')
    expect(reviewYml).toContain(
      "YOKE_FOUNDRY_API_KEY: ${{ inputs.provider == 'foundry' && inputs.azure-client-id == '' && secrets.REVIEW_CI_API_KEY || '' }}",
    )
    expect(reviewYml).toContain("YOKE_LITELLM_API_KEY: ${{ inputs.provider == 'litellm' && secrets.REVIEW_CI_API_KEY || '' }}")
  })

  it('rests the deliberate missing concurrency block on the reusable review job skipping synchronize events', () => {
    let topLevel = reusable.jobs.review.if
    while (/\([^()]*\)/.test(topLevel)) topLevel = topLevel.replace(/\([^()]*\)/g, 'group')
    expect(topLevel).not.toContain('||')
    expect(topLevel.split('&&').map((clause) => clause.trim())).toContain("github.event.action != 'synchronize'")
  })
})
