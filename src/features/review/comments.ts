export type PriorComment = { path: string | null; line: number | null; author: string; body: string }

const markerPrefix = '<!-- yoke-review:'

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function findingMarker({ file, title }: { file: string | null; title: string }): string {
  return `${markerPrefix} ${file ?? 'n/a'}#${slug(title)} -->`
}

export function hasMarker(prior: PriorComment[], marker: string): boolean {
  return prior.some((comment) => comment.body.includes(marker))
}

function withoutMarkers(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(markerPrefix))
    .join('\n')
    .trim()
}

function heading({ path, line }: PriorComment): string {
  if (!path) return '### PR review'
  return line === null ? `### ${path}` : `### ${path}:${line}`
}

export function formatPriorComments(prior: PriorComment[]): string {
  if (!prior.length) return ''
  const blocks = prior.map((comment) => `${heading(comment)}\n\n**${comment.author}**: ${withoutMarkers(comment.body)}`)
  return `## Prior review comments

The PR already has the review comments below, including resolved and outdated threads. Do not re-raise a finding a prior comment substantively covers.

${blocks.join('\n\n')}
`
}
