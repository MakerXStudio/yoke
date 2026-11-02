import { parseDiff } from './diff'

const yokeCaller = /\buses:\s*['"]?MakerXStudio\/yoke\/\.github\/workflows\/review\.yml@/i

function editsYokeCaller(diff: string): boolean {
  return parseDiff(diff).some(({ text, file, line }) => line !== null && file?.startsWith('.github/workflows/') && yokeCaller.test(text))
}

export function selfReviewNote(diff: string): string {
  if (!editsYokeCaller(diff)) return ''
  return `## Yoke's own review workflow

This change adds or edits a workflow that calls \`MakerXStudio/yoke/.github/workflows/review.yml\`, the CI setup for this review. Review it like any other file, but these are yoke's deliberate design: do not raise them as findings, keep them in a consolidated review, or mention them in a summary.

- Calling the workflow at \`@main\` rather than a tag or SHA.
- The trigger types, including leaving out \`synchronize\`: a review is re-run by marking the PR as draft and then ready for review.
- Draft PRs being reviewed twice: the reusable workflow already skips drafts.

Real defects in it are still findings, such as:

- Passing every secret with \`secrets: inherit\` instead of only \`REVIEW_CI_BASE_URL\` and \`REVIEW_CI_API_KEY\`.
- An input the reusable workflow does not declare.
- No \`permissions:\` block limiting the token to \`contents: read\` and \`pull-requests: write\`, plus \`id-token: write\` with \`azure-client-id\`. The reusable workflow sets no permissions of its own, so the caller's block is the only limit on the token its agents run with.
`
}
