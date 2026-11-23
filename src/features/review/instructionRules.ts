import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ignore from 'ignore'
import { parse } from 'yaml'

import { type Context, isFile, readText, realInside, statOf } from './instructionFiles'

export type Rule = { path: string; real: string; body: string; patterns: string[] | undefined }

const maxBracePatterns = 1000
const maxBraceWork = 10_000_000

function ruleFiles(ctx: Context, folder: string, visited: Set<string>): string[] {
  const real = realInside(ctx, folder)
  if (!real || visited.has(real) || !statOf(real)?.isDirectory()) return []
  visited.add(real)
  let names: string[]
  try {
    names = readdirSync(real)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const path = join(folder, name)
    if (isFile(ctx, path)) return name.endsWith('.md') ? [path] : []
    return ruleFiles(ctx, path, visited)
  })
}

function splitOutsideBraces(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

type BraceGroup = { head: string; tail: string; alternatives: string[]; next: number }

// The first matched brace group with two or more alternatives, found in one pass. An unmatched
// opening brace ahead of it stops the search, so the pattern is kept literally.
function braceGroup(pattern: string): BraceGroup | undefined {
  const ends = new Map<number, number>()
  const withComma = new Set<number>()
  const open: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    const top = open.at(-1)
    if (pattern[i] === '{') open.push(i)
    else if (pattern[i] === ',' && top !== undefined) withComma.add(top)
    else if (pattern[i] === '}' && top !== undefined) {
      open.pop()
      ends.set(top, i)
    }
  }
  for (let start = pattern.indexOf('{'); start >= 0; start = pattern.indexOf('{', start + 1)) {
    const end = ends.get(start)
    if (end === undefined) return undefined
    if (!withComma.has(start)) continue
    const alternatives = splitOutsideBraces(pattern.slice(start + 1, end))
    return { head: pattern.slice(0, start), tail: pattern.slice(end + 1), alternatives, next: 0 }
  }
  return undefined
}

// Expands depth first without recursion, and stops once the rule holds maxBracePatterns patterns
// or its work (the characters of every pattern visited) passes maxBraceWork.
function expandBraces(pattern: string, out: string[], budget: { work: number }) {
  const stack: BraceGroup[] = []
  const visit = (next: string) => {
    budget.work += next.length
    if (budget.work > maxBraceWork) return
    const group = braceGroup(next)
    if (group) stack.push(group)
    else out.push(next)
  }
  visit(pattern)
  for (let group = stack.at(-1); group && out.length < maxBracePatterns && budget.work <= maxBraceWork; group = stack.at(-1)) {
    const alternative = group.alternatives[group.next++]
    if (alternative === undefined) stack.pop()
    else visit(group.head + alternative + group.tail)
  }
}

function rawPatterns(paths: unknown): string[] {
  if (typeof paths === 'string') return splitOutsideBraces(paths)
  if (Array.isArray(paths)) return paths.filter((path): path is string => typeof path === 'string')
  return []
}

function rulePatterns(frontmatter: string): string[] | undefined {
  let data: unknown
  try {
    data = parse(frontmatter)
  } catch {
    return undefined
  }
  const paths = data !== null && typeof data === 'object' ? (data as { paths?: unknown }).paths : undefined
  const patterns: string[] = []
  const budget = { work: 0 }
  for (const raw of rawPatterns(paths)) {
    if (patterns.length >= maxBracePatterns || budget.work > maxBraceWork) break
    const pattern = raw.trim()
    if (pattern) expandBraces(pattern, patterns, budget)
  }
  // A rule that ran out of budget stays scoped, even with no patterns, rather than loading everywhere.
  if (budget.work > maxBraceWork) return patterns
  return patterns.every((pattern) => pattern === '**') ? undefined : patterns
}

function parseRule(ctx: Context, path: string): Rule | undefined {
  const file = readText(ctx, path)
  if (!file) return undefined
  const frontmatter = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(file.content)
  if (!frontmatter) return { path, real: file.real, body: file.content, patterns: undefined }
  try {
    return { path, real: file.real, body: file.content.slice(frontmatter[0].length), patterns: rulePatterns(frontmatter[1] ?? '') }
  } catch {
    return undefined
  }
}

export function rules(ctx: Context, dir: string): Rule[] {
  const paths = ruleFiles(ctx, join(dir, '.claude', 'rules'), new Set())
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return paths.flatMap((path) => parseRule(ctx, path) ?? [])
}

export function matches(rule: Rule, dir: string, file: string | undefined): boolean {
  if (!rule.patterns) return true
  if (file === undefined) return false
  try {
    return ignore().add(rule.patterns).ignores(relative(dir, file).split(sep).join('/'))
  } catch {
    return false
  }
}
