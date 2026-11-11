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
    expect(selfReviewNote(callerDiff)).toContain(
      'Not passing `REVIEW_CI_API_KEY` from a caller that passes `azure-client-id` and `provider: foundry`',
    )
    expect(reviewYml).toContain(
      "YOKE_FOUNDRY_API_KEY: ${{ inputs.provider == 'foundry' && inputs.azure-client-id == '' && secrets.REVIEW_CI_API_KEY || '' }}",
    )
    expect(reviewYml).toContain("YOKE_LITELLM_API_KEY: ${{ inputs.provider == 'litellm' && secrets.REVIEW_CI_API_KEY || '' }}")
  })

  it('rests the deliberate missing concurrency block on the reusable review job running on a push only when no review has started', () => {
    const condition = reusable.jobs.review.if.replace(/\s+/g, ' ')
    expect(condition).toContain("(github.event.action != 'synchronize' || needs.push.outputs.review == 'true')")
    expect(condition).toContain("github.event_name == 'pull_request_target' && github.event.action == 'labeled'")
    expect(condition.match(/github\.event_name == '\w+'/g)).toEqual([
      "github.event_name == 'pull_request'",
      "github.event_name == 'pull_request_target'",
    ])
  })
})
