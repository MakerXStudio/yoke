import { readFileSync, realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'

export type Context = { root: string; loaded: Set<string> }

const maxFileBytes = 4 * 1024 * 1024

function inside(root: string, real: string): boolean {
  return real === root || real.startsWith(root + sep)
}

export function realInside(ctx: Context, path: string): string | undefined {
  try {
    const real = realpathSync(path)
    return inside(ctx.root, real) ? real : undefined
  } catch {
    return undefined
  }
}

export function statOf(real: string) {
  try {
    return statSync(real)
  } catch {
    return undefined
  }
}

export function isFile(ctx: Context, path: string): boolean {
  const real = realInside(ctx, path)
  return real !== undefined && statOf(real)?.isFile() === true
}

export function readText(ctx: Context, path: string): { real: string; content: string } | undefined {
  const real = realInside(ctx, path)
  if (!real) return undefined
  const stat = statOf(real)
  if (!stat?.isFile() || stat.size > maxFileBytes) return undefined
  try {
    const content = readFileSync(real, 'utf8')
    return content.includes('\u0000') ? undefined : { real, content }
  } catch {
    return undefined
  }
}
