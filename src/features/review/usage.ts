import { appendFileSync } from 'node:fs'

import type { StepName } from './usedModels'

export type TokenUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

export type StepUsage = Partial<Record<StepName, TokenUsage>>

const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

type Field = (typeof fields)[number]

const rows: [StepName, string][] = [
  ['reviewer1', 'Reviewer 1'],
  ['reviewer2', 'Reviewer 2'],
  ['synthesis', 'Synthesis'],
]

const dash = '—'

function count(source: Record<string, unknown>, key: string | undefined): number | undefined {
  const value = key ? source[key] : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseUsage(raw: unknown, keys: Partial<Record<Field, string>>): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: TokenUsage = {}
  for (const field of fields) {
    const value = count(raw, keys[field])
    if (value !== undefined) usage[field] = value
  }
  return Object.keys(usage).length ? usage : undefined
}

function sum(values: (number | undefined)[]): number | undefined {
  const reported = values.filter((value) => value !== undefined)
  return reported.length ? reported.reduce((a, b) => a + b, 0) : undefined
}

function sumUsage(usages: (TokenUsage | undefined)[]): TokenUsage {
  const total: TokenUsage = {}
  for (const field of fields) {
    const value = sum(usages.map((usage) => usage?.[field]))
    if (value !== undefined) total[field] = value
  }
  return total
}

export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  return sumUsage([a, b])
}

function cell(value: number | undefined): string {
  return value === undefined ? dash : value.toLocaleString('en-US')
}

function row(label: string, usage: TokenUsage | undefined): string {
  return `| ${label} | ${fields.map((field) => cell(usage?.[field])).join(' | ')} |`
}

export function usageTable(usage: StepUsage): string {
  const total = sumUsage(rows.map(([step]) => usage[step]))
  return [
    '## Token usage',
    '',
    '| Slot | Input | Output | Cache read | Cache write |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows.map(([step, label]) => row(label, usage[step])),
    row('**Total**', total),
  ].join('\n')
}

export function jobSummary(summary: string, usage: StepUsage): string {
  return ['## Adversarial review', summary || 'No summary was given.', usageTable(usage)].join('\n\n')
}

export function writeJobSummary(summary: string, usage: StepUsage, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.GITHUB_STEP_SUMMARY
  if (!path) return false
  appendFileSync(path, `${jobSummary(summary, usage)}\n`)
  return true
}
