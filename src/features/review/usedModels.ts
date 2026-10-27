import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Harness } from './harness'
import type { Reviewer } from './slots'

export type StepName = Reviewer | 'synthesis'

export type UsedModels = Partial<Record<StepName, string>>

const repoUrl = 'https://github.com/MakerXStudio/yoke'

function modelsPath(reviewDir: string): string {
  return join(reviewDir, 'models.json')
}

function isUsedModels(value: unknown): value is UsedModels {
  return typeof value === 'object' && value !== null && Object.values(value).every((model) => typeof model === 'string')
}

export function readUsedModels(reviewDir: string): UsedModels {
  const path = modelsPath(reviewDir)
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return isUsedModels(parsed) ? parsed : {}
}

export function recordUsedModel(reviewDir: string, step: StepName, harness: Harness, model: string | undefined): void {
  const models = readUsedModels(reviewDir)
  models[step] = model ? (model.split('/').at(-1) ?? model) : `${harness} default`
  writeFileSync(modelsPath(reviewDir), `${JSON.stringify(models, null, 2)}\n`)
}

export function forgetUsedModel(reviewDir: string, step: StepName): void {
  const models = readUsedModels(reviewDir)
  if (!(step in models)) return
  delete models[step]
  writeFileSync(modelsPath(reviewDir), `${JSON.stringify(models, null, 2)}\n`)
}

function list(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '')
}

export function modelsFooter({ reviewer1, reviewer2, synthesis }: UsedModels): string {
  const reviewers = [reviewer1, reviewer2].filter((model) => model !== undefined)
  const used = [...(reviewers.length ? [`reviewed with ${list(reviewers)}`] : []), ...(synthesis ? [`combined with ${synthesis}`] : [])]
  return `---\n_Adversarial review by [yoke](${repoUrl})${used.length ? `: ${used.join('; ')}` : ''}._`
}
