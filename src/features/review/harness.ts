import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { type HarnessEvent, parseHarnessEvent } from './progress'
import { type Override, piKeyEnv, piModels } from './provider'
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
  onProgress?: (activity: string) => void
}

export type HarnessResult = { ok: true; model?: string; usage?: TokenUsage } | { ok: false; error: string }

export type RunHarness = (run: HarnessRun) => Promise<HarnessResult>

const tailLines = 20
const maxErrorChars = 300

const piFlags = [
  '--mode',
  'json',
  '--no-session',
  '--no-approve',
  '--no-extensions',
  '--no-mcp',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
]

export function piAgentDir(env: NodeJS.ProcessEnv, home = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (!dir) return join(home, '.pi', 'agent')
  return dir === '~' ? home : dir.replace(/^~(?=[/\\])/, home)
}

function pathKey(env: NodeJS.ProcessEnv): string {
  if ('PATH' in env) return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

function hasCommand(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const windows = platform === 'win32'
  const dirs = [join(piAgentDir(env), 'bin'), ...(env[pathKey(env)] ?? '').split(windows ? ';' : ':').filter(Boolean)]
  return dirs.some((dir) => names.some((name) => existsSync(join(dir, windows ? `${name}.exe` : name))))
}

function piTools(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const grep = hasCommand(['rg'], env, platform) ? ['grep'] : []
  const find = hasCommand(['fd', 'fdfind'], env, platform) ? ['find'] : []
  return ['read', 'ls', 'bash', ...grep, ...find].join(',')
}

export function harnessArgs(run: HarnessRun, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const { harness, reviewDir, outputPath, override, untrusted } = run
  const extra = override?.args ?? []
  if (harness === 'codex') return ['exec', '--sandbox', 'read-only', '--json', '--output-last-message', outputPath, ...extra, '-']
  if (harness === 'pi') return [...piFlags, '--tools', piTools(env, platform), ...extra]
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

function exitError(harness: Harness, code: number | null, output: string): string {
  const detail = tail(output)
  return [`${harness} exited with code ${code ?? 'unknown'}`, ...(detail ? [detail] : [])].join('\n')
}

const credentialShapes = [/Bearer\s+\S+/gi, /\bsk-[^\s"',}]+/g, /\beyJ[\w-]+(?:\.[\w-]+)*/g]

export function piFailure(stopReason: string | undefined, errorMessage: string | undefined, secret?: string): string {
  let line = errorMessage?.split('\n')[0]?.trim() ?? ''
  if (secret) line = line.split(secret).join('[redacted]')
  for (const shape of credentialShapes) line = line.replace(shape, '[redacted]')
  line = line.replace(/(key["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]').slice(0, maxErrorChars)
  return `pi stopped: ${stopReason ?? 'without a reply'}${line ? `: ${line}` : ''}`
}

function hasReview(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0
}

function createPiAgentDir(run: HarnessRun): string | undefined {
  const pi = run.harness === 'pi' ? run.override?.pi : undefined
  if (!pi) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'yoke-pi-'))
  writeFileSync(join(dir, 'models.json'), JSON.stringify(piModels(pi), null, 2))
  return dir
}

function childEnv(run: HarnessRun, agentDir: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...run.override?.env }
  if (run.harness !== 'pi') return env
  const pi = { ...env, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  if (!agentDir) return pi
  const key = pathKey(env)
  const path = [join(piAgentDir(env), 'bin'), env[key]].filter(Boolean).join(delimiter)
  return { ...pi, [key]: path, PI_CODING_AGENT_DIR: agentDir }
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
  if (code !== 0)
    return { ok: false, error: exitError(run.harness, code, [stderr || stream.text, stream.lastError].filter(Boolean).join('\n')) }
  if (run.harness === 'pi' && stream.stopReason !== 'stop')
    return { ok: false, error: piFailure(stream.stopReason, stream.errorMessage, run.override?.env[piKeyEnv]) }
  if (run.harness !== 'codex') writeFileSync(run.outputPath, stream.text)
  if (!hasReview(run.outputPath)) return { ok: false, error: `${run.harness} returned an empty review` }
  return { ok: true, ...(stream.model ? { model: stream.model } : {}), ...(stream.usage ? { usage: stream.usage } : {}) }
}

export const runHarness: RunHarness = (run) =>
  new Promise((resolve) => {
    const agentDir = createPiAgentDir(run)
    const finish = (result: HarnessResult) => {
      if (agentDir) rmSync(agentDir, { recursive: true, force: true })
      resolve(result)
    }
    const env = childEnv(run, agentDir)
    const shell = process.platform === 'win32'
    const args = harnessArgs(run, env)
    const child = spawn(run.harness, shell ? args.map(windowsQuote) : args, { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell })
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
    child.on('error', (error) => finish({ ok: false, error: spawnError(run.harness, error) }))
    child.on('close', (code) => {
      onLine(pending)
      finish(outcome(run, code, stream, stderr))
    })
  })
