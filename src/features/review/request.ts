import { formatPriorComments, type PriorComment } from './comments'
import { parseDiff } from './diff'
import { selfReviewNote } from './selfReviewNote'

export type PullRequest = {
  number: number
  url: string
  title: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  files: { path: string }[]
}

const gutterWidth = 6

function gutter(line: number | null): string {
  return `${(line === null ? '' : String(line)).padStart(gutterWidth)}  `
}

export function withNewFileLineNumbers(diff: string): string {
  return parseDiff(diff)
    .map(({ text, line }) => gutter(line) + text)
    .join('\n')
}

export function commentableLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>()
  for (const { file, line } of parseDiff(diff)) {
    if (file === null || line === null) continue
    const numbers = lines.get(file) ?? new Set<number>()
    lines.set(file, numbers.add(line))
  }
  return lines
}

export function buildRequest(pr: PullRequest, diff: string, prior: PriorComment[] = []): string {
  const files = pr.files.map((f) => `- ${f.path}`).join('\n') || '(none)'
  const priorSection = formatPriorComments(prior)
  const note = selfReviewNote(diff)
  return `# Code review request

- PR: #${pr.number} ${pr.title}
- Head: \`${pr.headRefName}\` (\`${pr.headRefOid}\`)
- Base: \`${pr.baseRefName}\` (\`${pr.baseRefOid}\`)

## Changed files

${files}

## Diff

Each added or context line is prefixed with a left gutter showing its line number in the new file. When citing a finding as \`file:line\`, use that gutter number — do **not** count lines in this document. Removed lines (\`-\`) and headers have a blank gutter and cannot be commented on.

\`\`\`diff
${withNewFileLineNumbers(diff.trimEnd())}
\`\`\`
${note && `\n${note}`}${priorSection && `\n${priorSection}`}`
}
