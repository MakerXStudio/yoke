import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'tsup'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createPiAgentDir, piArgs, piEnv, removeDir } from './pi'
import piExtension, { gitArgv, maxRangeBytes, type PiExtensionApi, readRange, refusedArg, runCommand } from './piExtension'

const config = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'diff.external=',
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-pi-extension-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function gitRepo(): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first commit')
  return dir
}

type Registered = Parameters<PiExtensionApi['registerTool']>[0]

function registered(): Map<string, Registered> {
  const tools = new Map<string, Registered>()
  piExtension({ registerTool: (tool) => tools.set(tool.name, tool) })
  return tools
}

function call(name: string, params: unknown): Promise<string> {
  const tool = registered().get(name)
  if (!tool) throw new Error(`${name} is not registered`)
  return tool.execute('id', params, undefined, undefined, { cwd: dir }).then((result) => result.content[0]?.text ?? '')
}

describe('gitArgv', () => {
  it('runs log, show and diff with config pinned and external diff and textconv off', () => {
    for (const subcommand of ['log', 'show', 'diff']) {
      expect(gitArgv(subcommand, ['-n', '1'])).toEqual([...config, subcommand, '--no-ext-diff', '--no-textconv', '-n', '1'])
    }
  })

  it('runs blame and merge-base with no forced flags', () => {
    expect(gitArgv('blame', ['a.txt'])).toEqual([...config, 'blame', 'a.txt'])
    expect(gitArgv('merge-base', ['main', 'HEAD'])).toEqual([...config, 'merge-base', 'main', 'HEAD'])
  })

  it('keeps the forced flags ahead of a -- in args', () => {
    expect(gitArgv('diff', ['--', 'src']).slice(config.length)).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--', 'src'])
  })

  it.each(['push', 'config', 'checkout', '-c', '--git-dir=x', undefined])('refuses subcommand %s', (subcommand) => {
    expect(() => gitArgv(subcommand, [])).toThrow('git subcommand must be one of log, show, blame, diff, merge-base')
  })

  it('refuses args that are not an array of strings', () => {
    expect(() => gitArgv('log', '-n 1')).toThrow('git args must be an array of strings')
    expect(() => gitArgv('log', [1])).toThrow('git args must be an array of strings')
  })

  it.each([
    '--output=/tmp/x',
    '--output-indicator-new=x',
    '--ext-diff',
    '--textconv',
    '--show-signature',
    '--remerge-diff',
    '--diff-merges=remerge',
    '--format=%G?',
    '--pretty=format:%GS',
  ])('refuses %s', (arg) => {
    expect(refusedArg(arg)).toBeDefined()
    expect(() => gitArgv('log', ['-n', '1', arg])).toThrow(arg)
  })

  it('allows copy detection and combined-diff flags after the subcommand', () => {
    expect(gitArgv('log', ['-C', '-c', '--format=%H %s']).slice(-3)).toEqual(['-C', '-c', '--format=%H %s'])
  })
})

describe('runCommand', () => {
  it('runs git log in the repo', async () => {
    const out = await runCommand('git', gitArgv('log', ['--format=%s']), { cwd: gitRepo() })
    expect(out.trim()).toBe('first commit')
  })

  it('does not hang on log --stdin, since stdin is closed', async () => {
    const out = await runCommand('git', gitArgv('log', ['--stdin', '--format=%s', 'HEAD']), { cwd: gitRepo(), timeoutMs: 5_000 })
    expect(out.trim()).toBe('first commit')
  })

  it('fails with git stderr on a nonzero exit', async () => {
    await expect(runCommand('git', gitArgv('show', ['nope']), { cwd: gitRepo() })).rejects.toThrow(/git exited with code 128: .*nope/)
  })

  it('kills the command after the timeout', async () => {
    const hang = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: dir, timeoutMs: 100 })
    await expect(hang).rejects.toThrow('timed out after 0.1s')
  })

  it('kills the command when the tool is aborted', async () => {
    const controller = new AbortController()
    const hang = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: dir, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(hang).rejects.toThrow('was aborted')
  })

  it('truncates output over the cap with a note', async () => {
    const out = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100_000))'], { cwd: dir, cap: 1_000 })
    expect(out).toBe(`${'x'.repeat(1_000)}\n[output truncated at 1000 bytes; narrow the command]`)
  })
})

describe('readRange', () => {
  it('reads a slice of a line longer than the cap, at most 50KB at a time', async () => {
    const path = join(dir, 'long.min.js')
    writeFileSync(path, `${'a'.repeat(maxRangeBytes)}${'b'.repeat(10_000)}\n`)
    const first = await readRange(path, 0, 80_000)
    expect(first).toBe(`${'a'.repeat(maxRangeBytes)}\n[bytes 0-${maxRangeBytes} of ${maxRangeBytes + 10_001}]`)
    const rest = await readRange(path, maxRangeBytes, 20_000)
    expect(rest).toBe(`${'b'.repeat(10_000)}\n\n[bytes ${maxRangeBytes}-${maxRangeBytes + 10_001} of ${maxRangeBytes + 10_001}]`)
  })

  it('returns nothing past the end of the file', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    expect(await readRange(join(dir, 'a.txt'), 10, 5)).toBe('\n[bytes 10-10 of 3]')
  })

  it.each([
    [-1, 5, 'offset must be a non-negative integer'],
    [1.5, 5, 'offset must be a non-negative integer'],
    [0, 0, 'length must be a positive integer'],
  ])('refuses offset %s and length %s', async (offset, length, error) => {
    await expect(readRange(join(dir, 'a.txt'), offset, length)).rejects.toThrow(error)
  })
})

describe('piExtension', () => {
  it('registers git and read_range with JSON Schema parameters', () => {
    const tools = registered()
    expect([...tools.keys()]).toEqual(['git', 'read_range'])
    expect(tools.get('git')?.parameters).toMatchObject({
      type: 'object',
      properties: { subcommand: { type: 'string', enum: ['log', 'show', 'blame', 'diff', 'merge-base'] }, args: { type: 'array' } },
      required: ['subcommand'],
    })
    expect(tools.get('read_range')?.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer' } },
      required: ['path', 'offset', 'length'],
    })
  })

  it('runs git in the tool context cwd', async () => {
    gitRepo()
    expect((await call('git', { subcommand: 'log', args: ['--format=%s'] })).trim()).toBe('first commit')
  })

  it('refuses remerge and signature args from the tool', async () => {
    gitRepo()
    await expect(call('git', { subcommand: 'show', args: ['--remerge-diff'] })).rejects.toThrow('--remerge-diff')
    await expect(call('git', { subcommand: 'log', args: ['--show-signature'] })).rejects.toThrow('--show-signature')
  })

  it('reads a range of a path relative to the tool context cwd, ignoring a leading @', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world')
    expect(await call('read_range', { path: '@a.txt', offset: 6, length: 5 })).toBe('world\n[bytes 6-11 of 11]')
  })
})

const request = z.object({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
})

type Request = z.infer<typeof request>

type Stub = { server: Server; url: string; requests: Request[] }

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  const body = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }
  return `data: ${JSON.stringify(body)}\n\n`
}

function toolCall(index: number, name: string, args: unknown) {
  return { index, id: `call_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

const replies = [
  chunk(
    {
      role: 'assistant',
      tool_calls: [
        toolCall(0, 'git', { subcommand: 'log', args: ['--format=%s'] }),
        toolCall(1, 'read_range', { path: 'a.txt', offset: 0, length: 3 }),
      ],
    },
    'tool_calls',
  ),
  `${chunk({ role: 'assistant', content: 'ok' }, null)}${chunk({}, 'stop')}`,
]

async function stubServer(): Promise<Stub> {
  const requests: Request[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (data: Buffer) => (body += data.toString('utf8')))
    req.on('end', () => {
      const reply = replies[requests.length] ?? replies[1]
      requests.push(request.parse(JSON.parse(body)))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`${reply}data: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub server has no port')
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function buildExtension(outDir: string): Promise<string> {
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'piExtension.ts')
  await build({ entry: { piExtension: entry }, outDir, format: ['esm'], target: 'node24', platform: 'node', config: false, silent: true })
  return join(outDir, 'piExtension.js')
}

function piCli(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js')
}

describe('pi with the built extension', () => {
  it('offers the model only read, ls, git and read_range, plus grep and find when present, and runs the yoke tools', async () => {
    const extension = await buildExtension(join(dir, 'dist'))
    gitRepo()
    const stub = await stubServer()
    const agentDir = createPiAgentDir({ baseUrl: stub.url, model: 'm' })
    const env = { ...process.env, YOKE_PI_API_KEY: 'k', PI_CODING_AGENT_DIR: join(dir, 'user-agent') }
    const args = piArgs(env, process.platform, ['--model', 'yoke/m'])
    args[args.indexOf('-e') + 1] = extension
    const child = spawn(process.execPath, [piCli(), ...args], { cwd: dir, env: piEnv(env, agentDir), stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf8')))
    child.stdin.end('Say ok')
    try {
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const names = (stub.requests[0]?.tools ?? []).map((tool) => tool.function.name).toSorted()
      expect(names).toEqual(args[args.indexOf('--tools') + 1]?.split(',').toSorted())
      expect(names).toEqual(expect.arrayContaining(['git', 'ls', 'read', 'read_range']))
      for (const shell of ['bash', 'edit', 'write']) expect(names).not.toContain(shell)
      const results = stub.requests[1]?.messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.stringify(message.content))
      expect(results).toEqual([expect.stringContaining('first commit'), expect.stringContaining('one')])
    } finally {
      child.kill()
      stub.server.close()
      removeDir(agentDir)
    }
  }, 60_000)
})
