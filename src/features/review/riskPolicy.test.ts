import { describe, expect, it } from 'vitest'

import { parseRiskPolicy, rateFiles, RiskPolicyError, withAiRating } from './riskPolicy'

const policy = parseRiskPolicy('mode: approve\nlowRisk: ["**/*.{tsx,md}"]\nalwaysHuman: ["src/auth/**"]\n')

describe('parseRiskPolicy', () => {
  it('reads mode and globs', () => {
    expect(policy).toEqual({
      mode: 'approve',
      lowRisk: ['**/*.{tsx,md}'],
      alwaysHuman: ['src/auth/**'],
      author: { minMergedPrs: 1 },
      trusted: [],
      sample: { rate: 0, label: 'yoke-risk-sampled' },
    })
  })

  it('defaults an empty file to approve mode with no globs', () => {
    expect(parseRiskPolicy('')).toEqual({
      mode: 'approve',
      lowRisk: [],
      alwaysHuman: [],
      author: { minMergedPrs: 1 },
      trusted: [],
      sample: { rate: 0, label: 'yoke-risk-sampled' },
    })
  })

  it('reads author thresholds, trusted people and sampling', () => {
    expect(
      parseRiskPolicy(
        'author:\n  minMergedPrs: 3\ntrusted: [alice, o/leads]\nsample:\n  rate: 0.1\n  reviewers: [bob, o/qa]\n  unknown: 1',
      ),
    ).toMatchObject({
      author: { minMergedPrs: 3 },
      trusted: ['alice', 'o/leads'],
      sample: { rate: 0.1, label: 'yoke-risk-sampled' },
    })
  })

  it('ignores the removed author.maxChangesRequested and author.recentPrs in an existing policy', () => {
    expect(parseRiskPolicy('author:\n  minMergedPrs: 2\n  maxChangesRequested: 1\n  recentPrs: 20\n').author).toEqual({ minMergedPrs: 2 })
  })

  it.each([
    ['an unknown mode', 'mode: yolo', 'is invalid'],
    ['a glob that is not a list', 'lowRisk: "**/*.md"', 'is invalid'],
    ['broken YAML', 'lowRisk: [', 'is not valid YAML'],
    ['an unknown merge method', 'mergeMethod: fast-forward', 'is invalid'],
    ['a first-time author allowed through', 'author:\n  minMergedPrs: 0', 'is invalid'],
    ['a sample rate above 1', 'sample:\n  rate: 10', 'is invalid'],
    ['a trusted entry that is not a login or team', 'trusted: ["a b"]', 'must be a login or an org/team-slug'],
  ])('rejects %s', (_, text, message) => {
    expect(() => parseRiskPolicy(text)).toThrow(RiskPolicyError)
    expect(() => parseRiskPolicy(text)).toThrow(message)
  })
})

describe('rateFiles', () => {
  it('rates a PR low when every file matches lowRisk', () => {
    expect(rateFiles(['README.md', 'src/ui/Button.tsx'], policy)).toEqual({
      level: 'low',
      reasons: ['every changed file matches `lowRisk` in the policy'],
    })
  })

  it.each([
    '.github/workflows/ci.yml',
    '.github/yoke-risk.yml',
    '.github/README.md',
    '.claude/settings.json',
    'packages/a/.claude/skills/x.md',
    '.codex/config.toml',
    '.mcp.json',
    'packages/a/.mcp.json',
  ])('rates %s high whatever the policy says', (file) => {
    const permissive = parseRiskPolicy('lowRisk: ["**", "**/.*", ".*/**", "**/.*/**"]')
    const rating = rateFiles(['README.md', file], permissive)
    expect(rating.level).toBe('high')
    expect(rating.reasons[0]).toContain(`\`${file}\``)
  })

  it('rates an alwaysHuman file high even when it matches lowRisk', () => {
    expect(rateFiles(['src/auth/Login.tsx'], policy)).toEqual({
      level: 'high',
      reasons: ['`src/auth/Login.tsx` matches `alwaysHuman` in the policy'],
    })
  })

  it('lists both kinds of high-risk file, naming each once', () => {
    const both = parseRiskPolicy('alwaysHuman: [".github/**", "infra/**"]')
    expect(rateFiles(['.github/x.yml', 'infra/main.tf'], both).reasons).toEqual([
      '`.github/x.yml` always needs a human (workflows, the risk policy or agent config)',
      '`infra/main.tf` matches `alwaysHuman` in the policy',
    ])
  })

  it('leaves a file outside every glob to the AI rating', () => {
    expect(rateFiles(['README.md', 'src/api.ts'], policy)).toEqual({
      level: 'undecided',
      reasons: ['`src/api.ts` matches no `lowRisk` glob, so the AI risk rating decides'],
      aiDecides: true,
    })
  })

  it('shortens long file lists', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    expect(rateFiles(files, policy).reasons[0]).toBe(
      '`a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts` and 2 more matches no `lowRisk` glob, so the AI risk rating decides',
    )
  })

  it('leaves a PR with no files undecided', () => {
    expect(rateFiles([], policy).level).toBe('undecided')
  })
})

describe('withAiRating', () => {
  const outside = rateFiles(['src/api.ts'], policy)

  it.each(['low', 'medium', 'high'] as const)('lets an AI rating of %s decide files outside the globs', (level) => {
    expect(withAiRating(outside, { level, reason: 'Small refactor.' })).toEqual({
      level,
      reasons: ['`src/api.ts` matches no `lowRisk` glob, so the AI risk rating decides', `AI risk rating: ${level}: Small refactor.`],
    })
  })

  it.each([null, undefined])('leaves files outside the globs undecided without an AI rating (%s)', (risk) => {
    expect(withAiRating(outside, risk)).toEqual({
      level: 'undecided',
      reasons: ['`src/api.ts` matches no `lowRisk` glob, so the AI risk rating decides', 'the synthesis gave no readable AI risk rating'],
    })
  })

  it('keeps a hard exclusion high whatever the AI says, recording its rating', () => {
    expect(withAiRating(rateFiles(['.github/workflows/ci.yml'], policy), { level: 'low', reason: 'Tiny.' })).toEqual({
      level: 'high',
      reasons: [
        '`.github/workflows/ci.yml` always needs a human (workflows, the risk policy or agent config)',
        'AI risk rating: low: Tiny. (not used, the globs decide)',
      ],
    })
  })

  it('keeps an all-lowRisk PR low whatever the AI says', () => {
    expect(withAiRating(rateFiles(['README.md'], policy), { level: 'high', reason: 'Big.' }).level).toBe('low')
  })

  it('leaves a glob rating alone when there is no AI rating', () => {
    const low = rateFiles(['README.md'], policy)
    expect(withAiRating(low, null)).toEqual(low)
  })
})
