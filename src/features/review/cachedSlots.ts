import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { StepName } from './usedModels'

type CachedSlots = Partial<Record<StepName, string>>

function slotsPath(reviewDir: string): string {
  return join(reviewDir, 'slots.json')
}

function isCachedSlots(value: unknown): value is CachedSlots {
  return typeof value === 'object' && value !== null && Object.values(value).every((slot) => typeof slot === 'string')
}

function readCachedSlots(reviewDir: string): CachedSlots {
  const path = slotsPath(reviewDir)
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return isCachedSlots(parsed) ? parsed : {}
}

export function cachedSlot(reviewDir: string, step: StepName): string | undefined {
  return readCachedSlots(reviewDir)[step]
}

export function recordSlot(reviewDir: string, step: StepName, slot: string): void {
  const slots = readCachedSlots(reviewDir)
  slots[step] = slot
  writeFileSync(slotsPath(reviewDir), `${JSON.stringify(slots, null, 2)}\n`)
}
