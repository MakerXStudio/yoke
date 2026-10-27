import { howToSet, type SettingKey, type Settings } from '../config/settings'
import type { Harness } from './harness'
import { ReviewError } from './pr'
import {
  buildOverride,
  isProviderKind,
  type Override,
  parseSlot,
  type Provider,
  providerKinds,
  type SlotModel,
  slotFormat,
} from './provider'

export type Slot = { harness: Harness; model?: string; override?: Override }

export type Reviewer = 'claude' | 'codex'

export type ReviewSlots = Record<Reviewer, Slot> & { synthesis?: Slot }

type SlotName = keyof ReviewSlots

const slotKeys: [SlotName, SettingKey][] = [
  ['claude', 'review.reviewer1'],
  ['codex', 'review.reviewer2'],
  ['synthesis', 'review.synthesis'],
]

const kindPlaceholder = `<${providerKinds.join('|')}>`

function kindError(kind: string | undefined): string | null {
  if (!kind) return `modelProvider.kind is not set; ${howToSet('modelProvider.kind', kindPlaceholder)}`
  if (!isProviderKind(kind))
    return `modelProvider.kind "${kind}" must be ${providerKinds.join(' or ')}; ${howToSet('modelProvider.kind', kindPlaceholder)}`
  return null
}

function readProvider(settings: Settings): Provider | string[] {
  const kind = settings['modelProvider.kind']
  const baseUrl = settings['modelProvider.baseUrl']
  const apiKey = settings['modelProvider.apiKey']
  if (kind && isProviderKind(kind) && baseUrl && apiKey) return { kind, baseUrl, apiKey }
  return [
    kindError(kind),
    baseUrl ? null : `modelProvider.baseUrl is not set; ${howToSet('modelProvider.baseUrl', '<url>')}`,
    apiKey ? null : `modelProvider.apiKey is not set; ${howToSet('modelProvider.apiKey', '<key>')}`,
  ].filter((error) => error !== null)
}

function toSlot(model: SlotModel | undefined, provider: Provider): Slot | undefined {
  return model && { ...model, override: buildOverride(model, provider) }
}

export function resolveSlots(settings: Settings): ReviewSlots {
  const models: Partial<Record<SlotName, SlotModel>> = {}
  const errors: string[] = []
  for (const [name, key] of slotKeys) {
    const value = settings[key]
    if (!value) continue
    const model = parseSlot(value)
    if (model) models[name] = model
    else errors.push(`${key} "${value}" must be ${slotFormat}; ${howToSet(key, '<harness:model>')}`)
  }
  if (!Object.keys(models).length && !errors.length) return { claude: { harness: 'claude' }, codex: { harness: 'codex' } }
  const provider = readProvider(settings)
  if (Array.isArray(provider)) errors.push(...provider)
  if (errors.length || Array.isArray(provider))
    throw new ReviewError(['Review settings are incomplete:', ...errors.map((error) => `- ${error}`)].join('\n'))
  return {
    claude: toSlot(models.claude, provider) ?? { harness: 'claude' },
    codex: toSlot(models.codex, provider) ?? { harness: 'codex' },
    synthesis: toSlot(models.synthesis, provider),
  }
}
