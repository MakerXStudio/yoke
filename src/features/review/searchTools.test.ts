import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { harnessArgs } from './harness'
import { ReviewFailure } from './run'
import {
  installAssets,
  installSearchTools,
  type SearchToolAsset,
  searchToolAssets,
  searchToolPins,
  searchToolTarget,
  searchToolTargets,
  systemTar,
  withSearchTools,
} from './searchTools'
import type { ReviewSlots } from './slots'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-search-tools-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function serve(...bodies: Buffer[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const body of bodies) fetch.mockResolvedValueOnce(new Response(new Uint8Array(body)))
  return fetch
}

function archive(stem: string, binary: string, format: 'tar.gz' | 'zip'): { asset: SearchToolAsset; bytes: Buffer } {
  const source = join(dir, 'source', stem)
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, binary), `#!/bin/sh\necho ${binary}\n`)
  chmodSync(join(source, binary), 0o755)
  writeFileSync(join(source, 'README.md'), 'not extracted')
  const file = `${stem}.${format}`
  const path = join(dir, file)
  const args = format === 'zip' ? ['--format', 'zip', '-cf'] : ['-czf']
  execFileSync('tar', [...args, path, '-C', join(dir, 'source'), stem])
  const bytes = readFileSync(path)
  return { asset: { url: `https://example.test/${file}`, file, member: `${stem}/${binary}`, sha256: sha256(bytes) }, bytes }
}

const hostTarReadsZip = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('bsdtar')

describe('searchToolTarget', () => {
  it.each([
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
  ])('maps %s on %s to %s', (platform, arch, target) => {
    expect(searchToolTarget(platform, arch)).toBe(target)
  })

  it.each([
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
    ['win32', 'ia32'],
    ['linux', 'riscv64'],
  ])('has no target for %s on %s', (platform, arch) => {
    expect(searchToolTarget(platform, arch)).toBeUndefined()
  })
})

describe('searchToolPins', () => {
  it('has a SHA-256 for every target of fd and rg', () => {
    expect(searchToolPins.map((pin) => pin.binary)).toEqual(['fd', 'rg'])
    for (const pin of searchToolPins)
      for (const target of searchToolTargets) expect(pin.sha256[target], `${pin.binary} ${target}`).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names each release asset and the binary inside it', () => {
    expect(searchToolAssets('x86_64-unknown-linux-musl')).toEqual([
      {
        url: 'https://github.com/sharkdp/fd/releases/download/v10.5.2/fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz',
        file: 'fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz',
        member: 'fd-v10.5.2-x86_64-unknown-linux-musl/fd',
        sha256: '7e2d07fa2b8807642aaec67b7e2972a9fbe4db26fcb340a7372392db42b26694',
      },
      {
        url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz',
        file: 'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz',
        member: 'ripgrep-15.2.0-x86_64-unknown-linux-musl/rg',
        sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
      },
    ])
    expect(searchToolAssets('aarch64-pc-windows-msvc').map((asset) => asset.member)).toEqual([
      'fd-v10.5.2-aarch64-pc-windows-msvc/fd.exe',
      'ripgrep-15.2.0-aarch64-pc-windows-msvc/rg.exe',
    ])
  })
})

describe('systemTar', () => {
  it("uses Windows' own tar, which reads zip", () => {
    expect(systemTar('win32', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\tar.exe')
    expect(systemTar('linux', {})).toBe('tar')
  })
})

const installed = (path: string) => readdirSync(path).toSorted()

describe('installAssets', () => {
  it('extracts only the binary of each verified archive', async () => {
    const fd = archive('fd-v1', 'fd', 'tar.gz')
    const rg = archive('ripgrep-1', 'rg', 'tar.gz')
    const fetch = serve(fd.bytes, rg.bytes)
    const tools = await installAssets([fd.asset, rg.asset], { fetch, tar: 'tar' })
    try {
      expect(installed(tools)).toEqual(['fd', 'rg'])
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([fd.asset.url, rg.asset.url])
      expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      rmSync(tools, { recursive: true, force: true })
    }
  })

  it.skipIf(!hostTarReadsZip)('extracts a binary from a zip', async () => {
    const rg = archive('ripgrep-1', 'rg.exe', 'zip')
    const tools = await installAssets([rg.asset], { fetch: serve(rg.bytes), tar: 'tar' })
    try {
      expect(installed(tools)).toEqual(['rg.exe'])
    } finally {
      rmSync(tools, { recursive: true, force: true })
    }
  })

  it('fails on a checksum mismatch and extracts nothing', async () => {
    const fd = archive('fd-v1', 'fd', 'tar.gz')
    const before = new Set(readdirSync(tmpdir()))
    const error = await installAssets([{ ...fd.asset, sha256: '0'.repeat(64) }], { fetch: serve(fd.bytes), tar: 'tar' }).catch((e) => e)
    expect(error).toBeInstanceOf(ReviewFailure)
    expect(error.message).toContain(`fd-v1.tar.gz has SHA-256 ${fd.asset.sha256}, expected ${'0'.repeat(64)}`)
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('yoke-search-tools-') && !before.has(name))).toEqual([])
  })

  it('fails when a download fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('gone', { status: 404 }))
    const error = await installAssets([archive('fd-v1', 'fd', 'tar.gz').asset], { fetch, tar: 'tar' }).catch((e) => e)
    expect(error).toBeInstanceOf(ReviewFailure)
    expect(error.message).toBe('Could not download https://example.test/fd-v1.tar.gz: HTTP 404')
  })

  it('fails closed on a runner with no pinned target', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(installSearchTools({ env: {}, platform: 'freebsd', arch: 'x64', fetch })).rejects.toThrow(ReviewFailure)
    expect(fetch).not.toHaveBeenCalled()
  })
})

function fakeInstall() {
  const tools = join(dir, 'tools')
  mkdirSync(tools)
  for (const name of ['fd', 'rg']) {
    writeFileSync(join(tools, name), '')
    chmodSync(join(tools, name), 0o755)
  }
  return vi.fn(async () => tools)
}

describe('withSearchTools', () => {
  const ci = { GITHUB_ACTIONS: 'true', PATH: '/usr/bin' }
  const piSlots: ReviewSlots = {
    reviewer1: { harness: 'pi', model: 'm', override: { args: ['--model', 'm'], env: { YOKE_PI_API_KEY: 'k' } } },
    reviewer2: { harness: 'claude' },
    synthesis: { harness: 'pi' },
  }

  it('skips the install outside CI', async () => {
    const install = fakeInstall()
    const run = vi.fn(async (slots: ReviewSlots) => slots)
    expect(await withSearchTools(piSlots, run, { env: { PATH: '/usr/bin' }, install })).toBe(piSlots)
    expect(install).not.toHaveBeenCalled()
  })

  it('skips the install when no slot uses pi', async () => {
    const install = fakeInstall()
    const slots: ReviewSlots = { reviewer1: { harness: 'claude' }, reviewer2: { harness: 'codex' } }
    expect(await withSearchTools(slots, async (given) => given, { env: ci, install })).toBe(slots)
    expect(install).not.toHaveBeenCalled()
  })

  it("puts the tools first on each pi slot's PATH, so pi offers grep and find, then removes them", async () => {
    const install = fakeInstall()
    const slots = await withSearchTools(piSlots, async (given) => given, { env: ci, platform: 'linux', install })
    const tools = join(dir, 'tools')
    expect(slots.reviewer1.override).toEqual({ args: ['--model', 'm'], env: { YOKE_PI_API_KEY: 'k', PATH: `${tools}:/usr/bin` } })
    expect(slots.synthesis?.override).toEqual({ args: [], env: { PATH: `${tools}:/usr/bin` } })
    expect(slots.reviewer2).toBe(piSlots.reviewer2)
    expect(existsSync(tools)).toBe(false)
  })

  it('offers grep and find to the pi child once the tools are on its PATH', async () => {
    const install = fakeInstall()
    const env = { ...ci, PI_CODING_AGENT_DIR: join(dir, 'agent') }
    await withSearchTools(
      piSlots,
      async (slots) => {
        const run = { harness: 'pi' as const, prompt: 'p', cwd: dir, reviewDir: dir, outputPath: join(dir, 'out.md') }
        const args = harnessArgs({ ...run, override: slots.reviewer1.override }, { ...env, ...slots.reviewer1.override?.env }, 'linux')
        expect(args[args.indexOf('--tools') + 1]).toBe('read,ls,bash,grep,find')
      },
      { env, platform: 'linux', install },
    )
    expect(install).toHaveBeenCalledOnce()
  })

  it('keeps the Windows Path key and the inherited path after the tools', async () => {
    const install = fakeInstall()
    const slots = await withSearchTools(piSlots, async (given) => given, {
      env: { GITHUB_ACTIONS: 'true', Path: 'C:\\Windows' },
      platform: 'win32',
      install,
    })
    expect(slots.synthesis?.override?.env).toEqual({ Path: `${join(dir, 'tools')};C:\\Windows` })
  })

  it('removes the tools when the review fails', async () => {
    const install = fakeInstall()
    const failed = withSearchTools(piSlots, async () => Promise.reject(new Error('boom')), { env: ci, install })
    await expect(failed).rejects.toThrow('boom')
    expect(existsSync(join(dir, 'tools'))).toBe(false)
  })
})
