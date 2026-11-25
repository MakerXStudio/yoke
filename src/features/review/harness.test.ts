import type * as fs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { harnessArgs, type HarnessRun, piFailure, runHarness, windowsQuote } from './harness'
import { piEnv, piExtension } from './pi/pi'

vi.mock('node:fs', async (actual) => {
  const real = await actual<typeof fs>()
  return { ...real, writeFileSync: vi.fn(real.writeFileSync) }
})

const run: HarnessRun = {
  harness: 'codex',
  prompt: 'p',
  cwd: '/repo',
  reviewDir: '/review',
  outputPath: '/review/out.md',
  instructions: false,
}

describe('harnessArgs', () => {
  it('runs codex read-only on stdin, streaming JSON events, with no overrides by default', () => {
    expect(harnessArgs(run)).toEqual(['exec', '--sandbox', 'read-only', '--json', '--output-last-message', '/review/out.md', '-'])
  })

  it('puts codex provider overrides before the stdin marker', () => {
    expect(harnessArgs({ ...run, override: { args: ['-m', 'gpt-5-codex'], env: {} } }).slice(-3)).toEqual(['-m', 'gpt-5-codex', '-'])
  })

  it('streams claude JSON events and appends provider overrides', () => {
    expect(harnessArgs({ ...run, harness: 'claude', override: { args: ['--model', 'sonnet'], env: {} } })).toEqual([
      '-p',
      '--add-dir',
      '/review',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
    ])
  })

  it("keeps claude from loading an untrusted checkout's settings, hooks and MCP servers", () => {
    expect(harnessArgs({ ...run, harness: 'claude', untrusted: true }).slice(0, 4)).toEqual([
      '-p',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
    ])
  })
})

describe('windowsQuote', () => {
  it('leaves arguments without spaces or quotes untouched', () => {
    expect(windowsQuote('Edit,Write,NotebookEdit')).toBe('Edit,Write,NotebookEdit')
  })

  it('quotes a path that contains a space', () => {
    expect(windowsQuote('C:\\Users\\Jane Doe\\review')).toBe('"C:\\Users\\Jane Doe\\review"')
  })

  it('escapes embedded quotes', () => {
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""')
  })
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-harness-test-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function binDir(name: string, files: string[]): string {
  const bin = join(dir, name)
  mkdirSync(bin, { recursive: true })
  for (const file of files) {
    writeFileSync(join(bin, file), '')
    chmodSync(join(bin, file), 0o755)
  }
  return bin
}

function agentEnv(): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: binDir('agent', []) }
}

describe('harnessArgs for pi', () => {
  const pi: HarnessRun = { ...run, harness: 'pi' }
  const flags = [
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
    '-e',
    piExtension,
  ]

  it('loads the extension source next to pi.ts when no build sits beside it', () => {
    expect(piExtension).toBe(join(import.meta.dirname, 'pi', 'piExtension.ts'))
  })

  it('runs pi locked down with only read, ls, git and read_range when neither rg nor fd is on PATH, then the model', () => {
    const env = { ...agentEnv(), PATH: binDir('empty', []) }
    expect(harnessArgs({ ...pi, override: { args: ['--model', 'yoke/kimi'], env: {} } }, env, 'linux')).toEqual([
      ...flags,
      '--tools',
      'read,ls,git,read_range',
      '--model',
      'yoke/kimi',
    ])
  })

  it('offers grep and find when rg and fd are on PATH', () => {
    const env = { ...agentEnv(), PATH: [binDir('a', ['rg']), binDir('b', ['fd'])].join(':') }
    expect(harnessArgs(pi, env, 'linux')).toEqual([...flags, '--tools', 'read,ls,git,read_range,grep,find'])
  })

  it.skipIf(process.platform === 'win32')('does not offer grep for an rg that is not executable or not a file', () => {
    const bin = binDir('a', ['rg'])
    chmodSync(join(bin, 'rg'), 0o644)
    mkdirSync(join(binDir('b', []), 'rg'))
    const env = { ...agentEnv(), PATH: [bin, join(dir, 'b')].join(':') }
    expect(harnessArgs(pi, env, 'linux').at(-1)).toBe('read,ls,git,read_range')
  })

  it("offers find with Debian's fdfind", () => {
    expect(harnessArgs(pi, { ...agentEnv(), PATH: binDir('a', ['fdfind']) }, 'linux').at(-1)).toBe('read,ls,git,read_range,find')
  })

  it("finds rg in pi's agent bin", () => {
    const agent = join(dir, 'agent')
    binDir(join('agent', 'bin'), ['rg'])
    expect(harnessArgs(pi, { PI_CODING_AGENT_DIR: agent, PATH: binDir('empty', []) }, 'linux').at(-1)).toBe('read,ls,git,read_range,grep')
  })

  it('reads the Windows Path key and looks for .exe tools', () => {
    const env = { ...agentEnv(), Path: [binDir('a', ['rg.exe']), binDir('b', ['fd'])].join(';') }
    expect(harnessArgs(pi, env, 'win32').at(-1)).toBe('read,ls,git,read_range,grep')
  })

  it('prefers PATH over Path', () => {
    const env = { ...agentEnv(), PATH: binDir('a', ['rg']), Path: binDir('b', ['fd']) }
    expect(harnessArgs(pi, env, 'linux').at(-1)).toBe('read,ls,git,read_range,grep')
  })
})

describe('piEnv', () => {
  const slots = [
    ['an own-auth', undefined],
    ['a provider', '/tmp/yoke-pi-x'],
  ] as const

  it.each(slots)('turns instruction loading on for %s slot', (_, agentDir) => {
    expect(piEnv({}, agentDir, true).YOKE_PI_INSTRUCTIONS).toBe('1')
  })

  it.each(slots)('leaves instruction loading off for %s slot', (_, agentDir) => {
    expect(piEnv({}, agentDir, false)).not.toHaveProperty('YOKE_PI_INSTRUCTIONS')
  })

  it.each(slots)('drops an inherited YOKE_PI_INSTRUCTIONS in any case for %s slot', (_, agentDir) => {
    const env = piEnv({ YOKE_PI_INSTRUCTIONS: '1', yoke_pi_instructions: '1', Yoke_Pi_Instructions: '1' }, agentDir, false)
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'YOKE_PI_INSTRUCTIONS')).toEqual([])
  })

  it.each(slots)('replaces an inherited lower-case key with one upper-case key for %s slot', (_, agentDir) => {
    const env = piEnv({ yoke_pi_instructions: '0' }, agentDir, true)
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'YOKE_PI_INSTRUCTIONS')).toEqual(['YOKE_PI_INSTRUCTIONS'])
    expect(env.YOKE_PI_INSTRUCTIONS).toBe('1')
  })
})

describe('piFailure', () => {
  it('keeps the stop reason and the first line of the error', () => {
    expect(piFailure('error', "400 Unsupported parameter: 'reasoning_effort' is not supported with this model.\nstack")).toBe(
      "pi stopped: error: 400 Unsupported parameter: 'reasoning_effort' is not supported with this model.",
    )
  })

  it('redacts the resolved credential, bearer tokens, sk- keys, JWTs and key values', () => {
    const error = piFailure(
      'error',
      '401: {"error":"secret-token-123 Authorization: Bearer abc.def sk-live_1 eyJhbGciOi.eyJzdWIi.sig api_key=plain Key: sk-...xyz"}',
      'secret-token-123',
    )
    expect(error).not.toMatch(/secret-token-123|abc\.def|sk-live_1|eyJ|plain|xyz/)
    expect(error).toContain('401: {"error":"[redacted] Authorization: [redacted]')
  })

  it('redacts a LiteLLM key hash', () => {
    expect(piFailure('error', 'Authentication Error, Invalid proxy server token passed. Key Hash (Token) =4a1f9c0e')).toBe(
      'pi stopped: error: Authentication Error, Invalid proxy server token passed. Key Hash (Token) =[redacted]',
    )
  })

  it('caps the error at 300 characters', () => {
    expect(piFailure('length', 'x'.repeat(400))).toBe(`pi stopped: length: ${'x'.repeat(300)}`)
  })

  it('says when pi stopped without a reply', () => {
    expect(piFailure(undefined, undefined)).toBe('pi stopped: without a reply')
  })
})

const usage = (input: number, output: number) => ({ input, output, cacheRead: 1, cacheWrite: 0, totalTokens: input + output + 1 })

function assistant(stopReason: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'message_end', message: { role: 'assistant', content, provider: 'yoke', model: 'kimi', stopReason, ...extra } }
}

const toolTurn = assistant('toolUse', [{ type: 'toolCall', name: 'grep', arguments: { pattern: 'TODO' } }], { usage: usage(100, 10) })
const reviewTurn = assistant('stop', [{ type: 'text', text: '## Findings\nNone.' }], { usage: usage(200, 20) })
const failedTurn = assistant('error', [], { usage: usage(0, 0), errorMessage: '429: rate limited' })

type PiEvent = { type: string; message?: unknown } & Record<string, unknown>

function stream(...events: PiEvent[]): string {
  const repeated = events.flatMap((event) =>
    event.type === 'message_end' ? [event, { type: 'turn_end', message: event.message }] : [event],
  )
  return [{ type: 'session', version: 3 }, { type: 'agent_start' }, ...repeated, { type: 'agent_end', messages: [] }]
    .map((event) => JSON.stringify(event))
    .join('\n')
}

function fakePi(output: string, script = ''): void {
  const bin = binDir('fake-bin', [])
  const fixture = join(dir, 'stream.jsonl')
  writeFileSync(fixture, `${output}\n`)
  writeFileSync(join(bin, 'pi'), `#!/bin/sh\ncat > /dev/null\n${script}\ncat '${fixture}'\n`)
  chmodSync(join(bin, 'pi'), 0o755)
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('PI_CODING_AGENT_DIR', binDir('user-agent', []))
}

const providerOverride = {
  args: ['--model', 'yoke/kimi'],
  env: { YOKE_PI_API_KEY: 'k-secret' },
  pi: { baseUrl: 'https://llm/v1', model: 'kimi' },
}

function stubTmpdir(): string {
  const temp = join(dir, 'tmp')
  mkdirSync(temp)
  vi.stubEnv('TMPDIR', temp)
  return temp
}

function piRun(): HarnessRun {
  return { ...run, harness: 'pi', cwd: dir, reviewDir: dir, outputPath: join(dir, 'out.md') }
}

describe.skipIf(process.platform === 'win32')('runHarness on a recorded pi stream', () => {
  it('writes the last reply and sums usage over every turn and compaction', async () => {
    const compaction = { type: 'compaction_end', reason: 'threshold', result: { summary: 's', usage: { input: 50, output: 5 } } }
    const activity: string[] = []
    fakePi(stream({ type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'TODO' } }, toolTurn, compaction, reviewTurn))
    const result = await runHarness({ ...piRun(), onProgress: (text) => activity.push(text) })
    expect(result).toEqual({ ok: true, model: 'kimi', usage: { input: 350, output: 35, cacheRead: 2, cacheWrite: 0 } })
    expect(readFileSync(join(dir, 'out.md'), 'utf8')).toBe('## Findings\nNone.')
    expect(activity).toEqual(['grep TODO'])
  })

  it('passes when a failed message is retried successfully', async () => {
    fakePi(stream(failedTurn, { type: 'auto_retry_start', attempt: 1, errorMessage: '429' }, reviewTurn))
    expect(await runHarness(piRun())).toMatchObject({ ok: true })
  })

  it.each([
    ['error', assistant('error', [], { errorMessage: '400 bad request' }), 'pi stopped: error: 400 bad request'],
    ['length', assistant('length', [{ type: 'text', text: 'partial' }]), 'pi stopped: length'],
    ['toolUse', toolTurn, 'pi stopped: toolUse'],
  ])('fails a final %s message even though pi exits 0', async (_, last, error) => {
    fakePi(stream(reviewTurn, last))
    expect(await runHarness(piRun())).toEqual({ ok: false, error })
    expect(existsSync(join(dir, 'out.md'))).toBe(false)
  })

  it('runs a provider slot in a temp agent dir holding its models.json, removed afterwards', async () => {
    const seen = join(dir, 'seen')
    fakePi(
      stream(reviewTurn),
      `echo "$PI_CODING_AGENT_DIR $PI_OFFLINE $PI_TELEMETRY $YOKE_PI_API_KEY" > '${seen}'\ncp "$PI_CODING_AGENT_DIR/models.json" '${seen}.json'\necho "$PATH" > '${seen}.path'`,
    )
    const override = { args: ['--model', 'yoke/kimi'], env: { YOKE_PI_API_KEY: 'k' }, pi: { baseUrl: 'https://llm/v1', model: 'kimi' } }
    expect(await runHarness({ ...piRun(), override })).toMatchObject({ ok: true })
    const [agentDir, offline, telemetry, key] = readFileSync(seen, 'utf8').trim().split(' ')
    expect([offline, telemetry, key]).toEqual(['1', '0', 'k'])
    expect(agentDir).not.toBe(process.env.PI_CODING_AGENT_DIR)
    expect(existsSync(agentDir ?? '')).toBe(false)
    expect(JSON.parse(readFileSync(`${seen}.json`, 'utf8'))).toMatchObject({ providers: { yoke: { baseUrl: 'https://llm/v1' } } })
    expect(readFileSync(`${seen}.path`, 'utf8').trim().split(delimiter).at(-1)).toBe(join(dir, 'user-agent', 'bin'))
  })

  it("resolves rg from the CI tools dir ahead of a stale one in the user's agent bin", async () => {
    const seen = join(dir, 'seen')
    fakePi(stream(reviewTurn), `command -v rg > '${seen}'`)
    binDir(join('user-agent', 'bin'), ['rg'])
    const tools = binDir('ci-tools', ['rg'])
    const env = { ...providerOverride.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` }
    expect(await runHarness({ ...piRun(), override: { ...providerOverride, env } })).toMatchObject({ ok: true })
    expect(readFileSync(seen, 'utf8').trim()).toBe(join(tools, 'rg'))
  })

  it('redacts the credential and key shapes when pi exits nonzero', async () => {
    fakePi('', "echo 'Error: 401 bad key k-secret Bearer tok Key Hash (Token) = 77ab' >&2\nexit 1")
    const result = await runHarness({ ...piRun(), override: providerOverride })
    expect(result).toEqual({
      ok: false,
      error: 'pi exited with code 1\nError: 401 bad key [redacted] [redacted] Key Hash (Token) = [redacted]',
    })
  })

  it('keeps the final error line of long exit output, redacting a secret at the truncation boundary', async () => {
    const noise = Array.from({ length: 30 }, (_, i) => `progress line ${i} ${'.'.repeat(20)}`).join('\n')
    const cause = 'Error: 401 invalid credentials'
    fakePi('', `cat <<'OUT' >&2\n${noise}\nk-secret${'x'.repeat(300 - cause.length - 5)}\n${cause}\nOUT\nexit 1`)
    const result = await runHarness({ ...piRun(), override: providerOverride })
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toMatch(/\nError: 401 invalid credentials$/)
    expect(error).not.toContain('cret')
  })

  it('fails the run, without leaking a temp dir, when writing models.json fails', async () => {
    const temp = stubTmpdir()
    fakePi(stream(reviewTurn))
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(await runHarness({ ...piRun(), override: providerOverride })).toEqual({
      ok: false,
      error: 'pi could not set up its agent dir: disk full',
    })
    expect(readdirSync(temp)).toEqual([])
  })

  it('fails the run when its temp dir cannot be made', async () => {
    vi.stubEnv('TMPDIR', join(dir, 'missing'))
    fakePi(stream(reviewTurn))
    expect(await runHarness({ ...piRun(), override: providerOverride })).toMatchObject({ ok: false })
  })

  it('fails the run and removes the temp dir when the review cannot be written', async () => {
    const temp = stubTmpdir()
    fakePi(stream(reviewTurn))
    const result = await runHarness({ ...piRun(), outputPath: join(dir, 'missing', 'out.md'), override: providerOverride })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('pi could not finish the review: ENOENT') })
    expect(readdirSync(temp)).toEqual([])
  })

  it("keeps the user's pi agent dir for an own-auth slot", async () => {
    const seen = join(dir, 'seen')
    fakePi(stream(reviewTurn), `echo "$PI_CODING_AGENT_DIR $PI_OFFLINE" > '${seen}'`)
    await runHarness(piRun())
    expect(readFileSync(seen, 'utf8').trim()).toBe(`${process.env.PI_CODING_AGENT_DIR} 1`)
  })

  it("keeps a provider env's YOKE_PI_INSTRUCTIONS from turning instruction loading on", async () => {
    const seen = join(dir, 'seen')
    fakePi(stream(reviewTurn), `echo "[$YOKE_PI_INSTRUCTIONS]" > '${seen}'`)
    const override = { ...providerOverride, env: { ...providerOverride.env, YOKE_PI_INSTRUCTIONS: '1' } }
    await runHarness({ ...piRun(), override })
    expect(readFileSync(seen, 'utf8').trim()).toBe('[]')
    await runHarness({ ...piRun(), override, instructions: true })
    expect(readFileSync(seen, 'utf8').trim()).toBe('[1]')
  })
})
