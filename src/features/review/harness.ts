import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { parseHarnessEvent } from './progress'
import type { Override } from './provider'

export type Harness = 'claude' | 'codex'

export type HarnessRun = {
  harness: Harness
  prompt: string
  cwd: string
  reviewDir: string
  outputPath: string
  override?: Override
  onProgress?: (activity: string) => void
}

export type HarnessResult = { ok: true; model?: string } | { ok: false; error: string }

export type RunHarness = (run: HarnessRun) => Promise<HarnessResult>

const tailLines = 20

export function harnessArgs({ harness, reviewDir, outputPath, override }: HarnessRun): string[] {
  const extra = override?.args ?? []
  if (harness === 'codex') return ['exec', '--sandbox', 'read-only', '--json', '--output-last-message', outputPath, ...extra, '-']
  return [
    '-p',
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

function hasReview(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0
}

export const runHarness: RunHarness = (run) =>
  new Promise((resolve) => {
    const shell = process.platform === 'win32'
    const args = harnessArgs(run)
    const child = spawn(run.harness, shell ? args.map(windowsQuote) : args, {
      cwd: run.cwd,
      env: { ...process.env, ...run.override?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    })
    let pending = ''
    let finalText = ''
    let model: string | undefined
    let lastError = ''
    let stderr = ''
    const onLine = (line: string) => {
      const event = parseHarnessEvent(run.harness, line)
      if (event.kind === 'activity') run.onProgress?.(event.text)
      if (event.kind === 'final') finalText = event.text
      if (event.kind === 'model') model = event.model
      if (event.kind === 'error') lastError = event.message
    }
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
    child.on('error', (error) => resolve({ ok: false, error: spawnError(run.harness, error) }))
    child.on('close', (code) => {
      onLine(pending)
      if (code !== 0)
        return resolve({ ok: false, error: exitError(run.harness, code, [stderr || finalText, lastError].filter(Boolean).join('\n')) })
      if (run.harness === 'claude') writeFileSync(run.outputPath, finalText)
      if (!hasReview(run.outputPath)) return resolve({ ok: false, error: `${run.harness} returned an empty review` })
      resolve(model ? { ok: true, model } : { ok: true })
    })
  })
