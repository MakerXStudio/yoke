import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'

import { gitArgv, gitSubcommands } from './piGit'
import { type InstructionHooks, loadInstructions } from './piInstructions'
import { resolvePath } from './piPaths'

type TextResult = { content: { type: 'text'; text: string }[]; details: undefined }

type ToolContext = { cwd: string }

type PiTool = {
  name: string
  label: string
  description: string
  promptSnippet: string
  parameters: Record<string, unknown>
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ToolContext): Promise<TextResult>
}

export type PiExtensionApi = { registerTool(tool: PiTool): void } & InstructionHooks

const outputCap = 50 * 1024
const gitTimeoutMs = 30_000
export const maxRangeBytes = 50 * 1024

type RunOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number; cap?: number; diffExit?: boolean }

type Capture = { chunks: Buffer[]; bytes: number; truncated: boolean }

function capture(cap: number, onFull: () => void) {
  const state: Capture = { chunks: [], bytes: 0, truncated: false }
  const add = (chunk: Buffer) => {
    if (state.truncated) return
    const room = cap - state.bytes
    state.chunks.push(chunk.subarray(0, room))
    state.bytes += Math.min(room, chunk.length)
    if (chunk.length > room) {
      state.truncated = true
      onFull()
    }
  }
  return { state, add, text: () => Buffer.concat(state.chunks).toString('utf8') }
}

type Ended = { file: string; code: number | null; stopped?: string; stdout: string; stderr: string; cap: number; diffExit: boolean }

// With diffExit, exit 1 means the inputs differ, as git diff --no-index and --exit-code report, unless git wrote only an error.
function commandOutput({ file, code, stopped, stdout, stderr, cap, diffExit }: Ended): string {
  if (stopped === 'truncated') return `${stdout}\n[output truncated at ${cap} bytes; narrow the command]`
  if (stopped) throw new Error(stopped)
  const differs = diffExit && code === 1 && (stdout !== '' || stderr === '')
  if (code !== 0 && !differs) throw new Error(`${file} exited with code ${code}: ${stderr}`)
  return stdout
}

export function runCommand(file: string, argv: string[], options: RunOptions): Promise<string> {
  const { cwd, signal, timeoutMs = gitTimeoutMs, cap = outputCap, diffExit = false } = options
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error(`${file} was aborted`))
    const env = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
    const child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stopped: string | undefined
    const stop = (reason: string) => {
      stopped ??= reason
      child.kill('SIGKILL')
    }
    const stdout = capture(cap, () => stop('truncated'))
    const stderr = capture(4 * 1024, () => {})
    const timer = setTimeout(() => stop(`${file} timed out after ${timeoutMs / 1000}s`), timeoutMs)
    const onAbort = () => stop(`${file} was aborted`)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', stdout.add)
    child.stderr.on('data', stderr.add)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      try {
        resolvePromise(commandOutput({ file, code, stopped, stdout: stdout.text(), stderr: stderr.text().trim(), cap, diffExit }))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function readRange(path: string, offset: number, length: number): Promise<string> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
  if (!Number.isInteger(length) || length <= 0) throw new Error('length must be a positive integer')
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const buffer = Buffer.alloc(Math.min(length, maxRangeBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    return `${text}\n[bytes ${offset}-${offset + bytesRead} of ${size}]`
  } finally {
    await handle.close()
  }
}

function textResult(value: string): TextResult {
  return { content: [{ type: 'text', text: value }], details: undefined }
}

type GitParams = { subcommand: unknown; args?: unknown }

type RangeParams = { path: string; offset: number; length: number }

const gitTool: PiTool = {
  name: 'git',
  label: 'git',
  description: `Run a read-only git command in the repo: ${gitSubcommands.join(', ')}. Output over ${outputCap / 1024}KB is truncated.`,
  promptSnippet: `Run read-only git ${gitSubcommands.join(', ')}`,
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: [...gitSubcommands], description: 'The git subcommand to run' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments after the subcommand, such as ["-n", "5", "--", "src"]' },
    },
    required: ['subcommand'],
    additionalProperties: false,
  },
  async execute(_id, params: GitParams, signal, _onUpdate, ctx) {
    const argv = gitArgv(params.subcommand, params.args ?? [])
    return textResult(await runCommand('git', argv, { cwd: ctx.cwd, signal, diffExit: params.subcommand === 'diff' }))
  },
}

const readRangeTool: PiTool = {
  name: 'read_range',
  label: 'read_range',
  description: `Read a byte range of a file as UTF-8, for lines too long for read. Reads at most ${maxRangeBytes / 1024}KB per call.`,
  promptSnippet: 'Read a byte range of a file, for lines too long for read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the repo or absolute' },
      offset: { type: 'integer', minimum: 0, description: 'Byte offset to start at' },
      length: { type: 'integer', minimum: 1, description: `Number of bytes to read, up to ${maxRangeBytes}` },
    },
    required: ['path', 'offset', 'length'],
    additionalProperties: false,
  },
  async execute(_id, params: RangeParams, _signal, _onUpdate, ctx) {
    return textResult(await readRange(resolvePath(ctx.cwd, params.path), params.offset, params.length))
  },
}

export default function piExtension(pi: PiExtensionApi): void {
  pi.registerTool(gitTool)
  pi.registerTool(readRangeTool)
  if (process.env.YOKE_PI_INSTRUCTIONS === '1') loadInstructions(pi)
}
