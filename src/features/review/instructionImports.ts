function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

function withoutFences(content: string): string {
  const lines = content.split('\n')
  let fence: string | undefined
  return lines
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence === undefined && marker) {
        fence = marker
        return ''
      }
      if (fence !== undefined) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined
        return ''
      }
      return line
    })
    .join('\n')
}

function proseOnly(content: string): string {
  return withoutFences(content)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blank)
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
