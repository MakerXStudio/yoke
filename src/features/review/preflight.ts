import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Harness } from './harness'
import { piAgentDir } from './pi/pi'
import type { ProbeRequest } from './provider'
import { sanitizeError } from './redact'
import { ReviewFailure } from './run'
import { implicitSynthesis, type ReviewSlots, type Slot } from './slots'

export type SignIn = 'signedIn' | 'signedOut' | 'unresolvedModel' | 'noModel' | 'unknownProvider' | 'invalidModels'

export type Checks = {
  onPath: (harness: Harness) => Promise<boolean>
  signedIn: (slot: Slot) => Promise<SignIn>
  reach: (probe: ProbeRequest) => Promise<string | undefined>
}

export type PiAuth = { check: (args: string[]) => Promise<{ code: number; stdout: string }>; defaultProvider: () => string | undefined }

const commandTimeout = 30_000
const probeTimeout = 60_000

function exec(harness: Harness, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const options = { encoding: 'utf8' as const, timeout: commandTimeout, shell: process.platform === 'win32' }
    execFile(harness, args, options, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout }),
    )
  })
}

async function claudeSignedIn(): Promise<boolean> {
  const { code, stdout } = await exec('claude', ['auth', 'status', '--json'])
  if (code !== 0) return false
  try {
    const parsed: unknown = JSON.parse(stdout)
    return typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && parsed.loggedIn === true
  } catch {
    return false
  }
}

export function piDefaultProvider(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(piAgentDir(env), 'settings.json'), 'utf8'))
    if (typeof settings !== 'object' || settings === null || !('defaultProvider' in settings)) return undefined
    return typeof settings.defaultProvider === 'string' && settings.defaultProvider ? settings.defaultProvider : undefined
  } catch {
    return undefined
  }
}

const piAuth: PiAuth = {
  check: (args) => exec('pi', ['auth', 'check', '--json', ...args]),
  defaultProvider: () => piDefaultProvider(),
}

export async function piSignIn(model: string | undefined, auth: PiAuth = piAuth): Promise<SignIn> {
  const provider = model ? undefined : auth.defaultProvider()
  if (!model && !provider) return 'noModel'
  const { code, stdout } = await auth.check(model ? ['--model', model] : ['--provider', provider ?? ''])
  const reason = piAuthReason(stdout)
  if (code === 0) return 'signedIn'
  if (reason === 'provider_not_found') return 'unknownProvider'
  if (reason === 'invalid_state') return model ? 'unresolvedModel' : 'invalidModels'
  if (code !== 2) return 'signedOut'
  return model ? 'unresolvedModel' : 'noModel'
}

function piAuthReason(stdout: string): string | undefined {
  try {
    const result: unknown = JSON.parse(stdout)
    if (typeof result !== 'object' || result === null || !('reason' in result)) return undefined
    return typeof result.reason === 'string' ? result.reason : undefined
  } catch {
    return undefined
  }
}

const signIn = (signedIn: boolean): SignIn => (signedIn ? 'signedIn' : 'signedOut')

function probeSecrets(headers: Record<string, string>): string[] {
  return [headers.Authorization?.replace(/^Bearer\s+/i, ''), headers['x-api-key']].filter((secret) => secret !== undefined)
}

function firstSseData(text: string): string | undefined {
  for (const event of text.replace(/\r\n?/g, '\n').split('\n\n').slice(0, -1)) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    if (data.length) return data.join('\n')
  }
  return undefined
}

// The first SSE data event of a streamed reply, or the whole body when the server ignored `stream`.
async function firstEvent(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return firstSseData(`${text}\n\n`) ?? text
      text += decoder.decode(value, { stream: true })
      const data = /^\s*[[{]/.test(text) ? undefined : firstSseData(text)
      if (data !== undefined) return data
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function errorPayload(event: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(event)
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed) || !parsed.error) return undefined
    const { error } = parsed
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return undefined
  }
}

export async function reach({ url, headers, body }: ProbeRequest): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(probeTimeout),
    })
    if (response.ok) {
      const error = errorPayload(await firstEvent(response))
      return error === undefined ? undefined : `HTTP ${response.status} with error: ${sanitizeError(error.trim(), probeSecrets(headers))}`
    }
    const text = sanitizeError((await response.text()).trim(), probeSecrets(headers))
    return `HTTP ${response.status}${text ? `: ${text}` : ''}`
  } catch (error) {
    if (!(error instanceof Error)) return String(error)
    const cause = error.cause instanceof Error ? error.cause.message : ''
    return cause ? `${error.message} (${cause})` : error.message
  }
}

const signedInChecks: Record<Harness, (slot: Slot) => Promise<SignIn>> = {
  claude: async () => signIn(await claudeSignedIn()),
  codex: async () => signIn((await exec('codex', ['login', 'status'])).code === 0),
  pi: ({ model }) => piSignIn(model),
}

const checks: Checks = {
  onPath: async (harness) => (await exec(harness, ['--version'])).code === 0,
  signedIn: (slot) => signedInChecks[slot.harness](slot),
  reach,
}

const loginHint: Record<Harness, string> = { claude: 'run `claude auth login`', codex: 'run `codex login`', pi: 'run `pi`, then `/login`' }

type SlotPrefix = 'review.reviewer1' | 'review.reviewer2' | 'review.synthesis'

type SlotUse = { slot: Slot; keys: SlotPrefix[] }

function signedOut({ slot: { harness }, keys }: SlotUse): string {
  const settings = keys.map((key) => `${key}.provider and ${key}.model`).join(', and ')
  return `${harness} is not signed in (${keys.join(', ')}); ${loginHint[harness]}, or run it through LiteLLM or Foundry by setting ${settings} (see \`yoke models\`)`
}

const piModelsJson = () => join(piAgentDir(process.env), 'models.json')

const signInProblem: Record<Exclude<SignIn, 'signedIn'>, (use: SlotUse) => string> = {
  signedOut,
  unresolvedModel: ({ slot }) =>
    `pi can't resolve model "${slot.model}"; use <provider>/<model> (see pi --list-models), and check ${piModelsJson()} is valid`,
  unknownProvider: ({ slot, keys }) =>
    `pi's provider for ${slot.model ? `model "${slot.model}"` : 'its default model'} is not built in or set in ${piModelsJson()} (${keys.join(', ')}); yoke runs pi without extensions, so Pi extension providers are unavailable to yoke`,
  invalidModels: ({ keys }) => `pi can't load its models (${keys.join(', ')}); fix ${piModelsJson()}`,
  noModel: ({ keys }) => `pi has no model: set ${keys.map((key) => `${key}.model`).join(' and ')}, or pick a default model in pi`,
}

async function slotProblem(use: SlotUse, check: Checks): Promise<string | undefined> {
  const { harness, model, probe } = use.slot
  if (!(await check.onPath(harness))) return `${harness} CLI not found on PATH; install it`
  if (!probe) {
    const state = await check.signedIn(use.slot)
    return state === 'signedIn' ? undefined : signInProblem[state](use)
  }
  const error = await check.reach(probe)
  return error && `${harness} model "${model}" at ${probe.url} (${use.keys.join(', ')}): ${error}`
}

function slotsToRun(slots: ReviewSlots): SlotUse[] {
  const uses: [SlotPrefix, Slot][] = [
    ['review.reviewer1', slots.reviewer1],
    ['review.reviewer2', slots.reviewer2],
    ['review.synthesis', slots.synthesis ?? implicitSynthesis(slots.reviewer1)],
  ]
  const distinct = new Map<string, SlotUse>()
  for (const [key, slot] of uses) {
    const id = slot.probe
      ? JSON.stringify({ provider: slot.provider, url: slot.probe.url, body: slot.probe.body })
      : `${slot.harness}:${slot.provider ?? 'own'}:${slot.model ?? ''}`
    const use = distinct.get(id)
    if (use) use.keys.push(key)
    else distinct.set(id, { slot, keys: [key] })
  }
  return [...distinct.values()]
}

export async function assertViable(slots: ReviewSlots, check: Checks = checks): Promise<void> {
  const problems = await Promise.all(slotsToRun(slots).map((use) => slotProblem(use, check)))
  const errors = problems.filter((problem) => problem !== undefined)
  if (errors.length)
    throw new ReviewFailure('a reviewer could not run', ['Cannot review:', ...errors.map((error) => `- ${error}`)].join('\n'))
}
