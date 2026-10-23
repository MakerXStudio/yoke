import { execFileSync } from 'node:child_process'

import { type Violation, validatePr } from './validate.ts'

export type RaiseOptions = { title: string; body: string; base?: string; draft: boolean }

export type RunGh = (args: string[]) => string

export class PrValidationError extends Error {
  constructor(readonly violations: Violation[]) {
    super(['PR description rejected:', ...violations.map((v) => `  ✗ ${v.rule}: ${v.message}`)].join('\n'))
    this.name = 'PrValidationError'
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
