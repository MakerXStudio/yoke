import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { type Violation, validatePr } from './validate'

export type RaiseOptions = { title: string; body: string; base?: string; draft: boolean }

export type RunGh = (args: string[]) => string

export class PrValidationError extends Error {
  constructor(readonly violations: Violation[]) {
    super(['PR description rejected:', ...violations.map((v) => `  ✗ ${v.rule}: ${v.message}`)].join('\n'))
    this.name = 'PrValidationError'
  }
}

export class PrBodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrBodyError'
  }
}

export type ReadBodyFile = (path: string) => string

const readBodyFile: ReadBodyFile = (path) => readFileSync(path === '-' ? 0 : path, 'utf8')

export function readBody({ body, bodyFile }: { body?: string; bodyFile?: string }, read: ReadBodyFile = readBodyFile): string {
  const text = bodyFile === undefined ? body : readFrom(bodyFile, read)
  if (text === undefined) throw new PrBodyError('Pass the PR body with --body or --body-file.')
  return text.replace(/^\uFEFF/, '')
}

function readFrom(path: string, read: ReadBodyFile): string {
  try {
    return read(path)
  } catch (error) {
    throw new PrBodyError(
      `Could not read the PR body from ${path === '-' ? 'stdin' : path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const runGh: RunGh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

export function raisePr({ title, body, base, draft }: RaiseOptions, run: RunGh = runGh): string {
  const violations = validatePr(title, body)
  if (violations.length) throw new PrValidationError(violations)

  const args = ['pr', 'create', '--title', title.trim(), '--body', body.trim()]
  if (base) args.push('--base', base)
  if (draft) args.push('--draft')
  const output = run(args).trim().split('\n')
  return output.at(-1) ?? ''
}
