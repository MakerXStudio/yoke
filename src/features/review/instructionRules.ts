import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ignore from 'ignore'
import { parse } from 'yaml'

import { type Context, isFile, readText, realInside, statOf } from './instructionFiles'

export type Rule = { path: string; real: string; body: string; patterns: string[] | undefined }

const maxBracePatterns = 1000

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

function braceGroup(pattern: string, from: number): { start: number; end: number } | undefined {
  const start = pattern.indexOf('{', from)
  if (start < 0) return undefined
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}' && --depth === 0) return { start, end: i }
  }
  return undefined
}

function expandBraces(pattern: string, limit = maxBracePatterns): string[] {
  let group = braceGroup(pattern, 0)
  while (group && splitOutsideBraces(pattern.slice(group.start + 1, group.end)).length < 2) group = braceGroup(pattern, group.start + 1)
  if (!group) return [pattern]
  const head = pattern.slice(0, group.start)
  const tail = pattern.slice(group.end + 1)
  const expanded: string[] = []
  for (const alternative of splitOutsideBraces(pattern.slice(group.start + 1, group.end))) {
    for (const next of expandBraces(head + alternative + tail, limit - expanded.length)) {
      if (expanded.length >= limit) return expanded
      expanded.push(next)
    }
  }
  return expanded
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
  for (const raw of rawPatterns(paths)) {
    const pattern = raw.trim()
    if (pattern) patterns.push(...expandBraces(pattern, maxBracePatterns - patterns.length))
  }
  return patterns.every((pattern) => pattern === '**') ? undefined : patterns
}

function parseRule(ctx: Context, path: string): Rule | undefined {
  const file = readText(ctx, path)
  if (!file) return undefined
  const frontmatter = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(file.content)
  if (!frontmatter) return { path, real: file.real, body: file.content, patterns: undefined }
  return { path, real: file.real, body: file.content.slice(frontmatter[0].length), patterns: rulePatterns(frontmatter[1] ?? '') }
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
