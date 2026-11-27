import { z } from 'zod'

import { parseRiskPolicy, type Rating, rateFiles, type RiskPolicy, RiskPolicyError, riskPolicyPath } from './riskPolicy'

export type Get = (path: string) => Promise<unknown>

const pullSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  html_url: z.string(),
  changed_files: z.number(),
  user: z.object({ login: z.string(), type: z.string() }),
  head: z.object({
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ sha: z.string() }),
  labels: z.array(z.object({ name: z.string() })).default([]),
  auto_merge: z
    .object({ enabled_by: z.object({ login: z.string() }).nullable() })
    .nullable()
    .default(null),
})

export type PullInfo = z.infer<typeof pullSchema>

const filesSchema = z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() }))

const reviewsSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    state: z.string(),
    commit_id: z.string().nullable(),
    user: z.object({ login: z.string() }).nullable(),
  }),
)

export type PostedReview = z.infer<typeof reviewsSchema>[number]

export type Policy = { text: string; branch: string; sha: string; url: string }

export const reviewAuthor = 'github-actions[bot]'

const reviewHeadings = ['## Adversarial review', '## Code review failed']

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(HTTP 404)')
}

export async function fetchPolicy(repo: string, deps: { get: Get }): Promise<Policy | null> {
  const { default_branch: branch } = z.object({ default_branch: z.string() }).parse(await deps.get(`repos/${repo}`))
  const ref = encodeURIComponent(branch)
  let file: unknown
  try {
    file = await deps.get(`repos/${repo}/contents/${riskPolicyPath}?ref=${ref}`)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  const { content, html_url: url } = z.object({ content: z.string(), html_url: z.string() }).parse(file)
  const commits = z
    .array(z.object({ sha: z.string() }))
    .parse(await deps.get(`repos/${repo}/commits?path=${riskPolicyPath}&sha=${ref}&per_page=1`))
  return {
    text: Buffer.from(content, 'base64').toString('utf8'),
    branch,
    sha: commits[0]?.sha ?? 'unknown',
    url,
  }
}

function postedReview(reviews: PostedReview[], head: string): PostedReview | undefined {
  return reviews.findLast(
    (review) =>
      review.user?.login === reviewAuthor && review.commit_id === head && reviewHeadings.some((heading) => review.body.startsWith(heading)),
  )
}

export function rate(
  policyText: string,
  files: z.infer<typeof filesSchema>,
  pull: PullInfo,
): { policy: RiskPolicy | null; rating: Rating } {
  let policy: RiskPolicy
  try {
    policy = parseRiskPolicy(policyText)
  } catch (error) {
    if (!(error instanceof RiskPolicyError)) throw error
    return {
      policy: null,
      rating: { level: 'undecided', reasons: [error.message] },
    }
  }
  if (files.length < pull.changed_files)
    return {
      policy,
      rating: {
        level: 'undecided',
        reasons: [`GitHub listed ${files.length} of the PR's ${pull.changed_files} changed files`],
      },
    }
  const paths = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])
  return { policy, rating: rateFiles(paths, policy) }
}

export async function fetchPull(repo: string, number: number, deps: { get: Get; paginate: (path: string) => Promise<unknown[]> }) {
  const pull = pullSchema.parse(await deps.get(`repos/${repo}/pulls/${number}`))
  const files = filesSchema.parse(await deps.paginate(`repos/${repo}/pulls/${pull.number}/files?per_page=100`))
  const reviews = reviewsSchema.parse(await deps.paginate(`repos/${repo}/pulls/${pull.number}/reviews?per_page=100`))
  return { pull, files, reviews, posted: postedReview(reviews, pull.head.sha) }
}
