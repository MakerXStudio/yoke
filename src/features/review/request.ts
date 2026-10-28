import { formatPriorComments, type PriorComment } from './comments'

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

const fileHeader = /^\+\+\+ (?:b\/)?(.+)$/
const hunkHeader = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const gutterWidth = 6

type DiffLine = { text: string; file: string | null; line: number | null }

type Hunk = { next: number; oldLeft: number; newLeft: number }

function hunkLine(text: string, hunk: Hunk): number | null {
  if (text.startsWith('-')) hunk.oldLeft--
  else if (text.startsWith('+')) hunk.newLeft--
  else if (text.startsWith(' ')) {
    hunk.oldLeft--
    hunk.newLeft--
  } else return null
  return text.startsWith('-') ? null : hunk.next++
}

function parseDiff(diff: string): DiffLine[] {
  let file: string | null = null
  const hunk: Hunk = { next: 0, oldLeft: 0, newLeft: 0 }
  return diff.split('\n').map((text) => {
    if (hunk.oldLeft > 0 || hunk.newLeft > 0) return { text, file, line: hunkLine(text, hunk) }
    const header = text.match(fileHeader)?.[1]
    if (header) file = header === '/dev/null' ? null : header
    const range = text.match(hunkHeader)
    if (range) Object.assign(hunk, { oldLeft: Number(range[1] ?? 1), next: Number(range[2]), newLeft: Number(range[3] ?? 1) })
    return { text, file, line: null }
  })
}

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
${priorSection && `\n${priorSection}`}`
}
