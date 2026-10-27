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
const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const gutterWidth = 6

function gutter(line: number | null): string {
  return `${(line === null ? '' : String(line)).padStart(gutterWidth)}  `
}

export function withNewFileLineNumbers(diff: string): string {
  let inFile = false
  let next = 0
  return diff
    .split('\n')
    .map((line) => {
      const hunk = line.match(hunkHeader)
      if (fileHeader.test(line)) inFile = true
      else if (hunk) next = Number(hunk[1])
      else if (inFile && (line.startsWith('+') || line.startsWith(' '))) return gutter(next++) + line
      return gutter(null) + line
    })
    .join('\n')
}

export function commentableLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>()
  let file: Set<number> | null = null
  let next = 0
  for (const line of diff.split('\n')) {
    const header = line.match(fileHeader)
    const hunk = line.match(hunkHeader)
    if (header?.[1]) {
      file = header[1] === '/dev/null' ? null : new Set()
      if (file) lines.set(header[1], file)
    } else if (hunk) next = Number(hunk[1])
    else if (file && (line.startsWith('+') || line.startsWith(' '))) file.add(next++)
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
