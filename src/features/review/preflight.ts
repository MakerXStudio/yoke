import { spawnSync } from 'node:child_process'

import type { SettingKey } from '../config/settings'
import type { Harness } from './harness'
import { ReviewError } from './pr'
import type { ProbeRequest } from './provider'
import type { ReviewSlots, Slot } from './slots'

export type Checks = {
  onPath: (harness: Harness) => boolean
  signedIn: (harness: Harness) => boolean
  reach: (probe: ProbeRequest) => Promise<string | undefined>
}

const commandTimeout = 30_000
const probeTimeout = 60_000
const maxBodyChars = 300

function exec(harness: Harness, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(harness, args, {
    encoding: 'utf8',
    timeout: commandTimeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  return { status: result.status, stdout: result.stdout ?? '' }
}

function claudeSignedIn(): boolean {
  const { status, stdout } = exec('claude', ['auth', 'status', '--json'])
  if (status !== 0) return false
  try {
    const parsed: unknown = JSON.parse(stdout)
    return typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && parsed.loggedIn === true
  } catch {
    return false
  }
}

async function reach({ url, headers, body }: ProbeRequest): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(probeTimeout),
    })
    if (response.ok) return undefined
    const text = (await response.text()).trim().slice(0, maxBodyChars)
    return `HTTP ${response.status}${text ? `: ${text}` : ''}`
  } catch (error) {
    if (!(error instanceof Error)) return String(error)
    const cause = error.cause instanceof Error ? error.cause.message : ''
    return cause ? `${error.message} (${cause})` : error.message
  }
}

const checks: Checks = {
  onPath: (harness) => exec(harness, ['--version']).status === 0,
  signedIn: (harness) => (harness === 'claude' ? claudeSignedIn() : exec('codex', ['login', 'status']).status === 0),
  reach,
}

const loginCommand: Record<Harness, string> = { claude: 'claude auth login', codex: 'codex login' }

type SlotUse = { slot: Slot; keys: SettingKey[] }

function signedOut({ slot: { harness }, keys }: SlotUse): string {
  const viaProvider = keys.map((key) => `\`yoke config set --user ${key} ${harness}:<model>@provider\``).join(' and ')
  return `${harness} is not signed in (${keys.join(', ')}); run \`${loginCommand[harness]}\`, or run it through the model provider: ${viaProvider}`
}

async function slotProblem(use: SlotUse, check: Checks): Promise<string | undefined> {
  const { harness, model, probe } = use.slot
  if (!check.onPath(harness)) return `${harness} CLI not found on PATH; install it`
  if (!probe) return check.signedIn(harness) ? undefined : signedOut(use)
  const error = await check.reach(probe)
  return error && `${harness} model "${model}" at ${probe.url}: ${error}`
}

function slotsToRun(slots: ReviewSlots): SlotUse[] {
  const uses: [SettingKey, Slot][] = [
    ['review.reviewer1', slots.claude],
    ['review.reviewer2', slots.codex],
    ['review.synthesis', slots.synthesis ?? { harness: slots.claude.harness }],
  ]
  const distinct = new Map<string, SlotUse>()
  for (const [key, slot] of uses) {
    const id = `${slot.harness}:${slot.model ?? ''}:${slot.probe ? 'provider' : 'own'}`
    const use = distinct.get(id)
    if (use) use.keys.push(key)
    else distinct.set(id, { slot, keys: [key] })
  }
  return [...distinct.values()]
}

export async function assertViable(slots: ReviewSlots, check: Checks = checks): Promise<void> {
  const problems = await Promise.all(slotsToRun(slots).map((use) => slotProblem(use, check)))
  const errors = problems.filter((problem) => problem !== undefined)
  if (errors.length) throw new ReviewError(['Cannot review:', ...errors.map((error) => `- ${error}`)].join('\n'))
}
