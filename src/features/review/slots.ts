import { howToSet, type SettingKey, type Settings } from '../config/settings'
import type { Harness } from './harness'
import { ReviewError } from './pr'
import {
  buildOverride,
  buildProbe,
  isProviderKind,
  type Override,
  ownAuthOverride,
  type ParsedSlot,
  parseSlot,
  type ProbeRequest,
  type Provider,
  providerKinds,
  type SlotModel,
  slotFormat,
} from './provider'

export type Slot = { harness: Harness; model?: string; override?: Override; probe?: ProbeRequest }

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

export function readProvider(settings: Settings): Provider | string[] {
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

function toSlot({ harness, model, viaProvider }: ParsedSlot, provider: Provider | null): Slot {
  if (!model) return { harness }
  const slot: SlotModel = { harness, model }
  if (viaProvider && provider) return { ...slot, override: buildOverride(slot, provider), probe: buildProbe(slot, provider) }
  return { ...slot, override: ownAuthOverride(slot) }
}

export function resolveSlots(settings: Settings): ReviewSlots {
  const parsed: Partial<Record<SlotName, ParsedSlot>> = {}
  const errors: string[] = []
  for (const [name, key] of slotKeys) {
    const value = settings[key]
    if (!value) continue
    const slot = parseSlot(value)
    if (slot) parsed[name] = slot
    else errors.push(`${key} "${value}" must be ${slotFormat}; ${howToSet(key, '<harness[:model][@provider]>')}`)
  }
  let provider: Provider | null = null
  if (Object.values(parsed).some((slot) => slot.viaProvider)) {
    const read = readProvider(settings)
    if (Array.isArray(read)) errors.push(...read)
    else provider = read
  }
  if (errors.length) throw new ReviewError(['Review settings are incomplete:', ...errors.map((error) => `- ${error}`)].join('\n'))
  return {
    claude: parsed.claude ? toSlot(parsed.claude, provider) : { harness: 'claude' },
    codex: parsed.codex ? toSlot(parsed.codex, provider) : { harness: 'codex' },
    synthesis: parsed.synthesis && toSlot(parsed.synthesis, provider),
  }
}
