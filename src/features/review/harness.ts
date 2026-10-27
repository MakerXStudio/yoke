import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import type { Override } from './provider'

export type Harness = 'claude' | 'codex'

export type HarnessRun = { harness: Harness; prompt: string; cwd: string; reviewDir: string; outputPath: string; override?: Override }

export type HarnessResult = { ok: true } | { ok: false; error: string }

export type RunHarness = (run: HarnessRun) => Promise<HarnessResult>

const tailLines = 20

export function harnessArgs({ harness, reviewDir, outputPath, override }: HarnessRun): string[] {
  const extra = override?.args ?? []
  if (harness === 'codex') return ['exec', '--sandbox', 'read-only', '--output-last-message', outputPath, ...extra, '-']
  return ['-p', '--add-dir', reviewDir, '--disallowedTools', 'Edit,Write,NotebookEdit', ...extra]
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
    const child = spawn(run.harness, harnessArgs(run), {
      cwd: run.cwd,
      env: { ...process.env, ...run.override?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdin.on('error', () => {})
    child.stdin.end(run.prompt)
    child.on('error', (error) => resolve({ ok: false, error: spawnError(run.harness, error) }))
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: exitError(run.harness, code, stderr || stdout) })
      if (run.harness === 'claude') writeFileSync(run.outputPath, stdout)
      if (!hasReview(run.outputPath)) return resolve({ ok: false, error: `${run.harness} returned an empty review` })
      resolve({ ok: true })
    })
  })
