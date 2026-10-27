import { howToSet, type SettingKey, type Settings } from '../config/settings'
import type { Harness } from './harness'
import { ReviewError } from './pr'
import {
  buildOverride,
  buildProbe,
  isHarness,
  isProviderKind,
  type Override,
  ownAuthOverride,
  type ProbeRequest,
  type Provider,
  type ProviderKind,
  providerKinds,
  type SlotModel,
} from './provider'

export type Slot = { harness: Harness; model?: string; provider?: ProviderKind; override?: Override; probe?: ProbeRequest }

export type Reviewer = 'reviewer1' | 'reviewer2'

export type ReviewSlots = Record<Reviewer, Slot> & { synthesis?: Slot }

type SlotName = keyof ReviewSlots

const slotNames: SlotName[] = ['reviewer1', 'reviewer2', 'synthesis']

type SlotSpec = { harness?: Harness; model?: string; provider?: ProviderKind }

export function readProvider(settings: Settings, kind: ProviderKind): Provider | string[] {
  const baseUrlKey = `${kind}.baseUrl` as const
  const apiKeyKey = `${kind}.apiKey` as const
  const baseUrl = settings[baseUrlKey]
  const apiKey = settings[apiKeyKey]
  if (baseUrl && apiKey) return { kind, baseUrl, apiKey }
  return [
    baseUrl ? null : `${baseUrlKey} is not set; ${howToSet(baseUrlKey, '<url>')}`,
    apiKey ? null : `${apiKeyKey} is not set; ${howToSet(apiKeyKey, '<key>')}`,
  ].filter((error) => error !== null)
}

function readSpec(settings: Settings, slot: SlotName, errors: string[]): SlotSpec | undefined {
  const keys = {
    harness: `review.${slot}.harness`,
    provider: `review.${slot}.provider`,
    model: `review.${slot}.model`,
  } as const satisfies Record<string, SettingKey>
  const harness = settings[keys.harness]
  const provider = settings[keys.provider]
  const model = settings[keys.model]
  if (!harness && !provider && !model) return undefined
  if (harness && !isHarness(harness))
    errors.push(`${keys.harness} "${harness}" must be claude or codex; ${howToSet(keys.harness, '<claude|codex>')}`)
  if (provider && !isProviderKind(provider))
    errors.push(
      `${keys.provider} "${provider}" must be ${providerKinds.join(' or ')}; ${howToSet(keys.provider, `<${providerKinds.join('|')}>`)}`,
    )
  if (provider && !model)
    errors.push(`${keys.model} is required when ${keys.provider} is set; ${howToSet(keys.model, '<model>')} (see \`yoke models\`)`)
  return {
    ...(harness && isHarness(harness) ? { harness } : {}),
    ...(provider && isProviderKind(provider) ? { provider } : {}),
    ...(model ? { model } : {}),
  }
}

type Providers = Partial<Record<ProviderKind, Provider>>

function toSlot({ harness: chosen, model, provider: kind }: SlotSpec, fallback: Harness, providers: Providers): Slot {
  const harness = chosen ?? fallback
  if (!model) return { harness }
  const slot: SlotModel = { harness, model }
  const provider = kind && providers[kind]
  if (provider) return { ...slot, provider: kind, override: buildOverride(slot, provider), probe: buildProbe(slot, provider) }
  return { ...slot, override: ownAuthOverride(slot) }
}

export function resolveSlots(settings: Settings): ReviewSlots {
  const specs: Partial<Record<SlotName, SlotSpec>> = {}
  const errors: string[] = []
  for (const name of slotNames) specs[name] = readSpec(settings, name, errors)
  const providers: Providers = {}
  for (const kind of new Set(Object.values(specs).flatMap((spec) => (spec?.provider ? [spec.provider] : [])))) {
    const read = readProvider(settings, kind)
    if (Array.isArray(read)) errors.push(...read)
    else providers[kind] = read
  }
  if (errors.length) throw new ReviewError(['Review settings are incomplete:', ...errors.map((error) => `- ${error}`)].join('\n'))
  const reviewer1 = toSlot(specs.reviewer1 ?? {}, 'claude', providers)
  return {
    reviewer1,
    reviewer2: toSlot(specs.reviewer2 ?? {}, 'codex', providers),
    synthesis: specs.synthesis && toSlot(specs.synthesis, reviewer1.harness, providers),
  }
}
