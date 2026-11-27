import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isMap, isScalar, parseDocument, type YAMLMap } from 'yaml'

import { callsReview } from './ciGateCaller'
import { appKeySecret } from './ciRisk'

export const appClientIdInput = 'review-app-client-id'
export const defaultClientIdVariable = 'YOKE_REVIEW_APP_CLIENT_ID'

export type LocalEdit = { path: string; added: string[] }

function reviewJob(jobs: unknown, repo: string): YAMLMap | undefined {
  if (!isMap(jobs)) return undefined
  for (const { value } of jobs.items) if (isMap(value) && callsReview(value.get('uses'), repo)) return value
  return undefined
}

function setMissing(job: YAMLMap, section: string, key: string, value: string): boolean {
  const existing = job.get(section, true)
  if (isScalar(existing) && existing.value === 'inherit') return false
  if (isMap(existing) && existing.has(key)) return false
  job.setIn([section, key], value)
  return true
}

function addAppInputs(content: string, repo: string): { content: string; added: string[] } | undefined {
  const doc = parseDocument(content)
  const job = reviewJob(doc.get('jobs', true), repo)
  if (!job) return undefined
  const added = [
    ...(setMissing(job, 'with', appClientIdInput, `\${{ vars.${defaultClientIdVariable} }}`) ? [`\`${appClientIdInput}\``] : []),
    ...(setMissing(job, 'secrets', appKeySecret, `\${{ secrets.${appKeySecret} }}`) ? [`\`${appKeySecret}\``] : []),
  ]
  return { content: added.length ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }) : content, added }
}

export function addLocalAppInputs(root: string, path: string, repo: string): LocalEdit | undefined {
  const file = join(root, path)
  if (!existsSync(file)) return undefined
  const result = addAppInputs(readFileSync(file, 'utf8'), repo)
  if (!result) return undefined
  if (result.added.length) writeFileSync(file, result.content)
  return { path, added: result.added }
}
