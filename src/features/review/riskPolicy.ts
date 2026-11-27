import { matchesGlob } from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

import type { AiRisk } from './findings'

export const riskPolicyPath = '.github/yoke-risk.yml'

const hardExclusions = ['.github/**', '**/.claude/**', '**/.codex/**', '**/.mcp.json']

export const sampleLabel = 'yoke-risk-sampled'

const principal = z.string().regex(/^[\w.-]+(\/[\w.-]+)?$/, 'must be a login or an org/team-slug')

const policySchema = z
  .object({
    mode: z.enum(['approve', 'merge']).default('approve'),
    lowRisk: z.array(z.string()).default([]),
    alwaysHuman: z.array(z.string()).default([]),
    mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
    author: z
      .object({
        minMergedPrs: z.number().int().min(1).default(1),
      })
      .prefault({}),
    trusted: z.array(principal).default([]),
    sample: z
      .object({
        rate: z.number().min(0).max(1).default(0),
        reviewers: z.array(principal).default([]),
        label: z.string().trim().min(1).max(50).default(sampleLabel),
      })
      .prefault({}),
  })
  .loose()

export type RiskPolicy = z.infer<typeof policySchema>

export type Rating = {
  level: 'high' | 'medium' | 'low' | 'undecided'
  reasons: string[]
  aiDecides?: boolean
}

export class RiskPolicyError extends Error {}

export function parseRiskPolicy(text: string): RiskPolicy {
  let raw: unknown
  try {
    raw = parse(text) ?? {}
  } catch (error) {
    throw new RiskPolicyError(`${riskPolicyPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const policy = policySchema.safeParse(raw)
  if (!policy.success) throw new RiskPolicyError(`${riskPolicyPath} is invalid: ${z.prettifyError(policy.error).replaceAll('\n', ' ')}`)
  return policy.data
}

const shownFiles = 5

function fileList(files: string[]): string {
  const shown = files.slice(0, shownFiles).map((file) => `\`${file}\``)
  return files.length > shownFiles ? `${shown.join(', ')} and ${files.length - shownFiles} more` : shown.join(', ')
}

function matching(files: string[], globs: string[]): string[] {
  return files.filter((file) => globs.some((glob) => matchesGlob(file, glob)))
}

export function rateFiles(files: string[], policy: RiskPolicy): Rating {
  const excluded = matching(files, hardExclusions)
  const human = matching(files, policy.alwaysHuman).filter((file) => !excluded.includes(file))
  const reasons = [
    ...(excluded.length ? [`${fileList(excluded)} always needs a human (workflows, the risk policy or agent config)`] : []),
    ...(human.length ? [`${fileList(human)} matches \`alwaysHuman\` in the policy`] : []),
  ]
  if (reasons.length) return { level: 'high', reasons }
  if (!files.length) return { level: 'undecided', reasons: ['the PR changes no files'] }
  const unmatched = files.filter((file) => !matching([file], policy.lowRisk).length)
  if (!unmatched.length)
    return {
      level: 'low',
      reasons: ['every changed file matches `lowRisk` in the policy'],
    }
  return {
    level: 'undecided',
    reasons: [`${fileList(unmatched)} matches no \`lowRisk\` glob, so the AI risk rating decides`],
    aiDecides: true,
  }
}

export function withAiRating({ aiDecides, ...rating }: Rating, risk: AiRisk | null | undefined): Rating {
  if (!risk) {
    const missing = 'the synthesis gave no readable AI risk rating'
    return aiDecides ? { level: 'undecided', reasons: [...rating.reasons, missing] } : rating
  }
  const ai = `AI risk rating: ${risk.level}: ${risk.reason}`
  if (aiDecides) return { level: risk.level, reasons: [...rating.reasons, ai] }
  return { ...rating, reasons: [...rating.reasons, `${ai} (not used, the globs decide)`] }
}
