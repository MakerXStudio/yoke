import { z } from 'zod'

import { ReviewError } from './pr'
import type { RiskPolicy } from './riskPolicy'

export type AuthorApi = {
  get: (path: string) => Promise<unknown>
  graphql: (query: string, variables: Record<string, string>) => Promise<unknown>
  orgGet?: (path: string) => Promise<unknown>
}

export type AuthorCheck = { passed: boolean; outcome: string }

type Author = { login: string; type: string }

const historySchema = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number(),
      nodes: z.array(z.object({ reviews: z.object({ totalCount: z.number() }).optional() })),
    }),
  }),
})

const permissionSchema = z.object({ permission: z.string(), role_name: z.string().optional() })

const reviewerSchema = z.object({
  type: z.string(),
  reviewer: z.object({ login: z.string().optional(), slug: z.string().optional() }).nullable(),
})

const environmentsSchema = z.object({
  environments: z
    .array(
      z.object({
        name: z.string(),
        protection_rules: z.array(z.object({ type: z.string(), reviewers: z.array(reviewerSchema).optional() })).default([]),
      }),
    )
    .default([]),
})

const membershipSchema = z.object({ state: z.string() })

function message(error: unknown): string {
  if (error instanceof ReviewError || error instanceof z.ZodError) return error.message
  throw error
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(HTTP 404)')
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

async function history(repo: string, login: string, recent: number, api: AuthorApi) {
  const query = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${recent}) {
    issueCount
    nodes { ... on PullRequest { reviews(states: CHANGES_REQUESTED) { totalCount } } }
  }
}`
  const { search } = historySchema.parse(
    await api.graphql(query, { q: `repo:${repo} is:pr is:merged author:${login} sort:created-desc` }),
  ).data
  const rounds = search.nodes.reduce((sum, node) => sum + (node.reviews?.totalCount ?? 0), 0)
  return { merged: search.issueCount, recent: search.nodes.length, rounds }
}

async function isTeamMember(org: string, slug: string, login: string, api: AuthorApi): Promise<boolean> {
  if (!api.orgGet) throw new ReviewError(`team \`${org}/${slug}\` needs the \`yoke-review\` App to check its members`)
  try {
    const { state } = membershipSchema.parse(await api.orgGet(`orgs/${org}/teams/${slug}/memberships/${login}`))
    return state === 'active'
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

type Exemption = { reason: string | null; notes: string[] }

type Check = () => Promise<string | null>

async function firstExemption(checks: Check[]): Promise<Exemption> {
  const notes: string[] = []
  for (const check of checks) {
    try {
      const reason = await check()
      if (reason) return { reason, notes }
    } catch (error) {
      notes.push(message(error))
    }
  }
  return { reason: null, notes }
}

function exemptionChecks(repo: string, login: string, trusted: string[], api: AuthorApi): Check[] {
  const [owner = ''] = repo.split('/')
  const trustedLogins = trusted.filter((entry) => !entry.includes('/'))
  const trustedTeams = trusted.filter((entry) => entry.includes('/'))
  return [
    async () => (trustedLogins.some((entry) => sameLogin(entry, login)) ? 'is listed as `trusted` in the policy' : null),
    async () => {
      const { permission, role_name } = permissionSchema.parse(await api.get(`repos/${repo}/collaborators/${login}/permission`))
      return permission === 'admin' || role_name === 'admin' ? 'is a repo admin' : null
    },
    async () => {
      const { environments } = environmentsSchema.parse(await api.get(`repos/${repo}/environments?per_page=100`))
      for (const environment of environments)
        for (const reviewer of environment.protection_rules.flatMap((rule) => rule.reviewers ?? [])) {
          const named = `is a required reviewer of the \`${environment.name}\` environment`
          if (reviewer.type === 'User' && reviewer.reviewer?.login && sameLogin(reviewer.reviewer.login, login)) return named
          if (reviewer.type === 'Team' && reviewer.reviewer?.slug && (await isTeamMember(owner, reviewer.reviewer.slug, login, api)))
            return `${named}, through the \`${owner}/${reviewer.reviewer.slug}\` team`
        }
      return null
    },
    ...trustedTeams.map((team) => async () => {
      const [org = '', slug = ''] = team.split('/')
      return (await isTeamMember(org, slug, login, api)) ? `is in the \`${team}\` team listed as \`trusted\` in the policy` : null
    }),
  ]
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

export async function checkAuthor(repo: string, author: Author, policy: RiskPolicy, api: AuthorApi): Promise<AuthorCheck> {
  const login = `\`${author.login}\``
  if (author.type === 'Bot') return { passed: false, outcome: `fails: ${login} is a bot, so its track record is not checked` }
  const { minMergedPrs, maxChangesRequested, recentPrs } = policy.author
  let record: Awaited<ReturnType<typeof history>>
  try {
    record = await history(repo, author.login, recentPrs, api)
  } catch (error) {
    return { passed: false, outcome: `fails: ${login}'s track record could not be read: ${message(error)}` }
  }
  const perPr = record.recent ? record.rounds / record.recent : 0
  const churn = `${perPr.toFixed(1)} changes-requested reviews per PR over the last ${plural(record.recent, 'merged PR')} (at most ${maxChangesRequested})`
  const merged = `${login} has ${plural(record.merged, 'merged PR')} here (at least ${minMergedPrs})`
  const facts: string[] = []
  let passed = true
  if (record.merged < minMergedPrs) {
    const { reason, notes } = await firstExemption(exemptionChecks(repo, author.login, policy.trusted, api))
    const unchecked = notes.length ? `; could not check every exemption: ${notes.join('; ')}` : ''
    if (reason) facts.push(`${merged}, but ${reason}, so the first-time rule does not apply`)
    else {
      facts.push(`${merged}, so is a first-time author and not low risk${unchecked}`)
      passed = false
    }
  } else facts.push(merged)
  if (perPr > maxChangesRequested) {
    facts.push(`${churn}, so is a high-churn author and not low risk`)
    passed = false
  } else facts.push(churn)
  return { passed, outcome: `${passed ? 'passes' : 'fails'}: ${facts.join('; ')}` }
}
