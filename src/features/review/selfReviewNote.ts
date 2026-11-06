import { parseDiff } from './diff'

const yokeCaller = /\buses:\s*['"]?MakerXStudio\/yoke\/\.github\/workflows\/review\.yml@/i

function editsYokeCaller(diff: string): boolean {
  return parseDiff(diff).some(({ text, file, line }) => line !== null && file?.startsWith('.github/workflows/') && yokeCaller.test(text))
}

export function selfReviewNote(diff: string): string {
  if (!editsYokeCaller(diff)) return ''
  return `## Yoke's own review workflow

This change adds or edits a workflow that calls \`MakerXStudio/yoke/.github/workflows/review.yml\`, the CI setup for this review. Review it like any other file, but these are yoke's deliberate design: do not raise them as findings, keep them in a consolidated review, or mention them in a summary.

- Calling the workflow at a \`review-vN\` tag rather than a SHA, or at \`@main\` in older callers.
- The trigger types, including \`synchronize\`: pushes run only the \`review / gate\` job, and a review is re-run by marking the PR as draft and then ready for review.
- No \`concurrency:\` block, with or without \`synchronize\`: the reusable workflow's \`review\` job skips \`synchronize\` events, so pushes and force-pushes start only gate jobs and don't overlap full reviews.
- The \`pull_request_target\` \`labeled\` trigger: a maintainer reads a fork PR's diff, then adds the \`review\` label to run its review with secrets. The reusable workflow runs the review on it only for that label on fork PRs, and refuses to review any commit pushed after the label. Its \`synchronize\` type removes the label when the fork pushes again.
- The \`actions: write\` and \`statuses: write\` permissions (or \`actions: read\` in older callers): the gate reads earlier runs to find the PR's latest review, records a fork's approved review as a commit status, and re-runs the PR head's gate.
- Draft PRs being reviewed twice: the reusable workflow already skips drafts.
- Not passing \`REVIEW_CI_API_KEY\` from a caller that passes \`azure-client-id\`, even when an older workflow passed it: \`azure-client-id\` is for Foundry, where the review signs in with the job's GitHub OIDC token and ignores \`REVIEW_CI_API_KEY\`.

Real defects in it are still findings, such as:

- Passing every secret with \`secrets: inherit\` instead of only \`REVIEW_CI_API_KEY\` (plus \`REVIEW_CI_BASE_URL\` from callers that still pass the URL as a secret).
- Not passing \`REVIEW_CI_API_KEY\` from a caller without \`azure-client-id\`: LiteLLM, and Foundry without OIDC, sign in with it.
- An input the reusable workflow does not declare.
- No \`permissions:\` block limiting the token to \`actions: write\`, \`contents: read\`, \`pull-requests: write\` and \`statuses: write\`, plus \`id-token: write\` with \`azure-client-id\`. The reusable workflow sets no permissions of its own, so the caller's block is the only limit on the token its agents run with.
`
}
