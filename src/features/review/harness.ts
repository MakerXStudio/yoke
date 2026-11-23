import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { createPiAgentDir, piArgs, piEnv, removeDir } from './pi/pi'
import { type HarnessEvent, parseHarnessEvent } from './progress'
import { type Override, piKeyEnv } from './provider'
import { sanitizeError } from './redact'
import { addUsage, type TokenUsage } from './usage'

export type Harness = 'claude' | 'codex' | 'pi'

export type HarnessRun = {
  harness: Harness
  prompt: string
  cwd: string
  reviewDir: string
  outputPath: string
  override?: Override
  untrusted?: boolean
  instructions: boolean
  onProgress?: (activity: string) => void
}

export type HarnessResult = { ok: true; model?: string; usage?: TokenUsage } | { ok: false; error: string }

export type RunHarness = (run: HarnessRun) => Promise<HarnessResult>

const tailLines = 20

export function harnessArgs(run: HarnessRun, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const { harness, reviewDir, outputPath, override, untrusted } = run
  const extra = override?.args ?? []
  if (harness === 'codex') return ['exec', '--sandbox', 'read-only', '--json', '--output-last-message', outputPath, ...extra, '-']
  if (harness === 'pi') return piArgs(env, platform, extra)
  return [
    '-p',
    ...(untrusted ? ['--setting-sources', 'user', '--strict-mcp-config'] : []),
    '--add-dir',
    reviewDir,
    '--disallowedTools',
    'Edit,Write,NotebookEdit',
    '--output-format',
    'stream-json',
    '--verbose',
    ...extra,
  ]
}

export function windowsQuote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-tailLines).join('\n')
}

function spawnError(harness: Harness, error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') return `${harness} CLI not found on PATH; install it or sign in, then retry`
  return `${harness} failed to start: ${error.message}`
}

function exitError(harness: Harness, code: number | null, output: string, secret?: string): string {
  const detail = harness === 'pi' ? sanitizeError(tail(output), [secret], { keep: 'end' }) : tail(output)
  return [`${harness} exited with code ${code ?? 'unknown'}`, ...(detail ? [detail] : [])].join('\n')
}

export function piFailure(stopReason: string | undefined, errorMessage: string | undefined, secret?: string): string {
  const line = sanitizeError(errorMessage?.split('\n')[0]?.trim() ?? '', [secret])
  return `pi stopped: ${stopReason ?? 'without a reply'}${line ? `: ${line}` : ''}`
}

function hasReview(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Stream = { text: string; model?: string; usage?: TokenUsage; lastError: string; stopReason?: string; errorMessage?: string }

function applyMessage(stream: Stream, event: Extract<HarnessEvent, { kind: 'message' }>): void {
  stream.text = event.text
  stream.stopReason = event.stopReason
  stream.errorMessage = event.errorMessage
  if (event.usage) stream.usage = addUsage(stream.usage, event.usage)
  if (event.model) stream.model = event.model
}

function applyEvent(stream: Stream, event: HarnessEvent, onProgress?: (activity: string) => void): void {
  if (event.kind === 'activity') onProgress?.(event.text)
  if (event.kind === 'message') applyMessage(stream, event)
  if (event.kind === 'final') {
    stream.text = event.text
    if (event.usage) stream.usage = event.usage
  }
  if (event.kind === 'usage') stream.usage = addUsage(stream.usage, event.usage)
  if (event.kind === 'model') stream.model = event.model
  if (event.kind === 'error') stream.lastError = event.message
}

function outcome(run: HarnessRun, code: number | null, stream: Stream, stderr: string): HarnessResult {
  const secret = run.override?.env[piKeyEnv]
  if (code !== 0) {
    const output = [stderr || stream.text, stream.lastError].filter(Boolean).join('\n')
    return { ok: false, error: exitError(run.harness, code, output, secret) }
  }
  if (run.harness === 'pi' && stream.stopReason !== 'stop')
    return { ok: false, error: piFailure(stream.stopReason, stream.errorMessage, secret) }
  if (run.harness !== 'codex') writeFileSync(run.outputPath, stream.text)
  if (!hasReview(run.outputPath)) return { ok: false, error: `${run.harness} returned an empty review` }
  return { ok: true, ...(stream.model ? { model: stream.model } : {}), ...(stream.usage ? { usage: stream.usage } : {}) }
}

function settle(run: HarnessRun, agentDir: string | undefined, resolve: (result: HarnessResult) => void) {
  let settled = false
  return (result: () => HarnessResult) => {
    if (settled) return
    settled = true
    try {
      resolve(result())
    } catch (error) {
      resolve({ ok: false, error: `${run.harness} could not finish the review: ${messageOf(error)}` })
    } finally {
      removeDir(agentDir)
    }
  }
}

export const runHarness: RunHarness = (run) =>
  new Promise((resolve) => {
    let agentDir: string | undefined
    try {
      agentDir = run.harness === 'pi' ? createPiAgentDir(run.override?.pi) : undefined
    } catch (error) {
      resolve({ ok: false, error: `pi could not set up its agent dir: ${messageOf(error)}` })
      return
    }
    const finish = settle(run, agentDir, resolve)
    try {
      spawnHarness(run, agentDir, finish)
    } catch (error) {
      finish(() => ({ ok: false, error: `${run.harness} failed to start: ${messageOf(error)}` }))
    }
  })

function spawnHarness(run: HarnessRun, agentDir: string | undefined, finish: (result: () => HarnessResult) => void): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...run.override?.env }
  const childEnv = run.harness === 'pi' ? piEnv(env, agentDir, run.instructions) : env
  const shell = process.platform === 'win32'
  const args = harnessArgs(run, env)
  const child = spawn(run.harness, shell ? args.map(windowsQuote) : args, {
    cwd: run.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
  })
  let pending = ''
  const stream: Stream = { text: '', lastError: '' }
  let stderr = ''
  const onLine = (line: string) => applyEvent(stream, parseHarnessEvent(run.harness, line), run.onProgress)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop() ?? ''
    lines.forEach(onLine)
  })
  child.stderr.on('data', (chunk: string) => (stderr += chunk))
  child.stdin.on('error', () => {})
  child.stdin.end(run.prompt)
  child.on('error', (error) => finish(() => ({ ok: false, error: spawnError(run.harness, error) })))
  child.on('close', (code) =>
    finish(() => {
      onLine(pending)
      return outcome(run, code, stream, stderr)
    }),
  )
}
