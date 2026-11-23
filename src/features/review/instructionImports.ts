function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

function fenceMarker(line: string): string | undefined {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
}

// The line must be outside any fence; `state` carries an unclosed comment to the next line.
function lineWithoutComments(line: string, state: { inComment: boolean }): string {
  let out = ''
  let from = 0
  while (from < line.length) {
    if (state.inComment) {
      const end = line.indexOf('-->', from)
      const stop = end < 0 ? line.length : end + 3
      out += blank(line.slice(from, stop))
      state.inComment = end < 0
      from = stop
    } else {
      const start = line.indexOf('<!--', from)
      if (start < 0) return out + line.slice(from)
      out += `${line.slice(from, start)}    `
      state.inComment = true
      from = start + 4
    }
  }
  return out
}

// One pass, so a fence marker inside a comment opens no fence and a comment opener inside a fence
// opens no comment.
function withoutFencesAndComments(content: string): string {
  let fence: string | undefined
  const state = { inComment: false }
  return content
    .split('\n')
    .map((line) => {
      const marker = fenceMarker(line)
      if (fence !== undefined) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined
        return ''
      }
      if (!state.inComment && marker) {
        fence = marker
        return ''
      }
      return lineWithoutComments(line, state)
    })
    .join('\n')
}

// A code span runs to the next backtick run of the same length; a run with no closer is literal.
// Each length's closers are searched forward only, so the scan stays linear.
function paragraphWithoutCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  const byLength = new Map<number, { indexes: number[]; next: number }>()
  runs.forEach((run, index) => {
    const length = run.end - run.start
    const entry = byLength.get(length) ?? { indexes: [], next: 0 }
    entry.indexes.push(index)
    byLength.set(length, entry)
  })
  let out = ''
  let last = 0
  let closed = -1
  for (const [index, open] of runs.entries()) {
    const entry = byLength.get(open.end - open.start)
    if (index <= closed || !entry) continue
    while ((entry.indexes[entry.next] ?? Infinity) <= index) entry.next++
    const closeIndex = entry.indexes[entry.next]
    const close = closeIndex === undefined ? undefined : runs[closeIndex]
    if (closeIndex === undefined || !close) continue
    out += text.slice(last, open.start) + blank(text.slice(open.start, close.end))
    last = close.end
    closed = closeIndex
  }
  return out + text.slice(last)
}

// A code span can't cross a blank line, so each paragraph is handled on its own.
function withoutCodeSpans(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((part, index) => (index % 2 === 0 ? paragraphWithoutCodeSpans(part) : part))
    .join('')
}

function proseOnly(content: string): string {
  return withoutCodeSpans(withoutFencesAndComments(content))
}

function isImportPath(path: string): boolean {
  if (path.startsWith('./') || path.startsWith('~/')) return true
  if (path.startsWith('/')) return path !== '/'
  return !path.startsWith('@') && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path)
}

export function importPaths(content: string): string[] {
  const paths: string[] = []
  for (const match of proseOnly(content).matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
    const raw = match[1] ?? ''
    const path = (raw.split('#', 1)[0] ?? '').replace(/\\ /g, ' ')
    if (path && isImportPath(path)) paths.push(path)
  }
  return paths
}
