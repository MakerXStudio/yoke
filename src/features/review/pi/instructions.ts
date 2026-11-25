import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { type Context, isFile, readText, realInside } from './instructionFiles'
import { importPaths } from './instructionImports'
import { matches, type Rule, rules } from './instructionRules'

export type Instruction = { path: string; content: string }

const readCutChars = 40_000
const maxImportHops = 4

function importTarget(from: string, path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(dirname(from), path)
}

function loadImports(ctx: Context, from: string, content: string, hops: number, out: Instruction[]) {
  if (hops >= maxImportHops) return
  for (const path of importPaths(content)) loadFile(ctx, importTarget(from, path), hops + 1, out)
}

function loadFile(ctx: Context, path: string, hops: number, out: Instruction[]) {
  const file = readText(ctx, path)
  if (!file || ctx.loaded.has(file.real)) return
  ctx.loaded.add(file.real)
  out.push({ path, content: file.content })
  loadImports(ctx, path, file.content, hops, out)
}

function loadRule(ctx: Context, rule: Rule, out: Instruction[]) {
  if (ctx.loaded.has(rule.real)) return
  ctx.loaded.add(rule.real)
  out.push({ path: rule.path, content: rule.body })
  loadImports(ctx, rule.path, rule.body, 0, out)
}

function chain(ctx: Context, dir: string): { before: string[]; local: string | undefined } {
  const at = (name: string) => join(dir, name)
  const claude = [at('CLAUDE.md'), at(join('.claude', 'CLAUDE.md'))].filter((path) => isFile(ctx, path))
  const claudeLocal = isFile(ctx, at('CLAUDE.local.md')) ? at('CLAUDE.local.md') : undefined
  if (claudeLocal || claude.length > 0) return { before: claude, local: claudeLocal }
  const agents = isFile(ctx, at('AGENTS.md')) ? [at('AGENTS.md')] : []
  return { before: agents, local: isFile(ctx, at('AGENTS.local.md')) ? at('AGENTS.local.md') : undefined }
}

function loadDir(ctx: Context, dir: string, file: string | undefined, out: Instruction[]) {
  if (!realInside(ctx, dir)) return
  const { before, local } = chain(ctx, dir)
  for (const path of before) loadFile(ctx, path, 0, out)
  for (const rule of rules(ctx, dir)) if (matches(rule, dir, file)) loadRule(ctx, rule, out)
  if (local) loadFile(ctx, local, 0, out)
}

function context(cwd: string, loaded: Set<string>): Context | undefined {
  try {
    return { root: realpathSync(cwd), loaded }
  } catch {
    return undefined
  }
}

function cut(instruction: Instruction): Instruction {
  if (instruction.content.length <= readCutChars) return instruction
  const note = `\n\n[Cut at ${readCutChars.toLocaleString('en-US')} characters. Read ${instruction.path} for the rest.]`
  return { path: instruction.path, content: instruction.content.slice(0, readCutChars) + note }
}

export function rootInstructions(cwd: string, loaded: Set<string>): Instruction[] {
  const ctx = context(cwd, loaded)
  if (!ctx) return []
  const out: Instruction[] = []
  loadDir(ctx, ctx.root, undefined, out)
  return out
}

function dirsDownTo(ctx: Context, real: string): string[] {
  const segments = relative(ctx.root, dirname(real)).split(sep).filter(Boolean)
  return [ctx.root, ...segments.map((_, i) => join(ctx.root, ...segments.slice(0, i + 1)))]
}

export function readInstructions(cwd: string, file: string, loaded: Set<string>): Instruction[] {
  const ctx = context(cwd, loaded)
  if (!ctx) return []
  const real = realInside(ctx, file)
  if (!real || real === ctx.root) return []
  const out: Instruction[] = []
  for (const dir of dirsDownTo(ctx, real)) loadDir(ctx, dir, real, out)
  return out.map(cut)
}
