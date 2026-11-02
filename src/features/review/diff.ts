type DiffLine = { text: string; file: string | null; line: number | null }

type Hunk = { next: number; oldLeft: number; newLeft: number }

const fileHeader = /^\+\+\+ (.+)$/

const hunkHeader = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }

export function parseDiff(diff: string): DiffLine[] {
  let file: string | null = null
  const hunk: Hunk = { next: 0, oldLeft: 0, newLeft: 0 }
  return diff.split('\n').map((text) => {
    if (hunk.oldLeft > 0 || hunk.newLeft > 0) return { text, file, line: hunkLine(text, hunk) }
    const header = text.match(fileHeader)?.[1]
    if (header) file = header === '/dev/null' ? null : diffPath(header)
    const range = text.match(hunkHeader)
    if (range) Object.assign(hunk, { oldLeft: Number(range[1] ?? 1), next: Number(range[2]), newLeft: Number(range[3] ?? 1) })
    return { text, file, line: null }
  })
}

function hunkLine(text: string, hunk: Hunk): number | null {
  if (text.startsWith('-')) hunk.oldLeft--
  else if (text.startsWith('+')) hunk.newLeft--
  else if (text.startsWith(' ')) {
    hunk.oldLeft--
    hunk.newLeft--
  } else return null
  return text.startsWith('-') ? null : hunk.next++
}

function diffPath(raw: string): string {
  const quoted = raw.match(/^"(.*)"$/)?.[1]
  const path = quoted === undefined ? raw : unquote(quoted)
  return path.startsWith('b/') ? path.slice(2) : path
}

function unquote(quoted: string): string {
  const parts = quoted.split(/(\\[0-7]{3}|\\.)/)
  return Buffer.concat(parts.map((part, i) => (i % 2 ? escapedBytes(part) : Buffer.from(part)))).toString('utf8')
}

function escapedBytes(escape: string): Buffer {
  const code = escape.slice(1)
  if (/^[0-7]{3}$/.test(code)) return Buffer.from([parseInt(code, 8)])
  return Buffer.from([escapes[code] ?? code.charCodeAt(0)])
}
