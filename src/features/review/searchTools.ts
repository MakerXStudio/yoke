import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isCi } from './ciRun'
import { pathKey, removeDir } from './pi'
import { ReviewFailure } from './run'
import { type ReviewSlots, type Slot, usesPi } from './slots'

export const searchToolTargets = [
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
] as const

export type SearchToolTarget = (typeof searchToolTargets)[number]

type Pin = { binary: string; release: string; stem: string; sha256: Record<SearchToolTarget, string> }

export const searchToolPins: Pin[] = [
  {
    binary: 'fd',
    release: 'https://github.com/sharkdp/fd/releases/download/v10.5.2',
    stem: 'fd-v10.5.2',
    sha256: {
      'x86_64-unknown-linux-musl': '7e2d07fa2b8807642aaec67b7e2972a9fbe4db26fcb340a7372392db42b26694',
      'aarch64-unknown-linux-musl': '63ea52cb31586e6d98efa2f06d73d542f16c7d0c4af0f07b579aaf9714cf907a',
      'x86_64-apple-darwin': '0f02e6000a8c896cd254cf4dccc7da1e604e77a32c6783609eed5e4cb07785e3',
      'aarch64-apple-darwin': '81bf98a16d3d7230e4a9123fcede243d71ea31a577113476ed43f1cdf4773162',
      'x86_64-pc-windows-msvc': '7edac75ef96b7e9a01ebb251a21ee86ea365a09adcfb865f1ec3346a906153b6',
      'aarch64-pc-windows-msvc': '0ee570ad513e6e1909642dbd79bf7177cf3457652e912c27726582c0f49df86e',
    },
  },
  {
    binary: 'rg',
    release: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0',
    stem: 'ripgrep-15.2.0',
    sha256: {
      'x86_64-unknown-linux-musl': '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
      'aarch64-unknown-linux-musl': '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915',
      'x86_64-apple-darwin': 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
      'aarch64-apple-darwin': '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
      'x86_64-pc-windows-msvc': '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
      'aarch64-pc-windows-msvc': 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
    },
  },
]

export type SearchToolAsset = { url: string; file: string; member: string; sha256: string }

const downloadTimeoutMs = 60_000
const extractTimeoutMs = 60_000

const failure = (message: string) => new ReviewFailure('fd and rg could not be installed', message)

const archs: Partial<Record<string, string>> = { x64: 'x86_64', arm64: 'aarch64' }
const systems: Partial<Record<string, string>> = { linux: 'unknown-linux-musl', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }

export function searchToolTarget(platform: string, arch: string): SearchToolTarget | undefined {
  const target = `${archs[arch]}-${systems[platform]}`
  return searchToolTargets.find((known) => known === target)
}

export function searchToolAssets(target: SearchToolTarget): SearchToolAsset[] {
  const windows = target.endsWith('windows-msvc')
  return searchToolPins.map(({ binary, release, stem, sha256 }) => {
    const file = `${stem}-${target}${windows ? '.zip' : '.tar.gz'}`
    return { url: `${release}/${file}`, file, member: `${stem}-${target}/${binary}${windows ? '.exe' : ''}`, sha256: sha256[target] }
  })
}

export type InstallDeps = { fetch: typeof globalThis.fetch; tar: string }

export function systemTar(platform: string, env: NodeJS.ProcessEnv): string {
  return platform === 'win32' ? `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar'
}

async function download(asset: SearchToolAsset, fetch: InstallDeps['fetch']): Promise<Buffer> {
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(downloadTimeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw failure(`Could not download ${asset.url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function extract(tar: string, archive: string, member: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-xf', archive, '-C', dir, '--strip-components=1', member]
    execFile(tar, args, { timeout: extractTimeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(failure(`Could not extract ${member}: ${error.killed ? 'timed out' : stderr.trim() || error.message}`))
      else resolve()
    })
  })
}

export async function installAssets(assets: SearchToolAsset[], { fetch, tar }: InstallDeps): Promise<string> {
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'yoke-search-tools-'))
    for (const asset of assets) {
      const bytes = await download(asset, fetch)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== asset.sha256) throw failure(`${asset.file} has SHA-256 ${actual}, expected ${asset.sha256}`)
      const archive = join(dir, asset.file)
      writeFileSync(archive, bytes)
      await extract(tar, archive, asset.member, dir)
      rmSync(archive)
    }
    return dir
  } catch (error) {
    removeDir(dir)
    if (error instanceof ReviewFailure) throw error
    throw failure(error instanceof Error ? error.message : String(error))
  }
}

export type SearchToolDeps = { env: NodeJS.ProcessEnv; platform: string; arch: string; fetch: typeof globalThis.fetch }

export async function installSearchTools({ env, platform, arch, fetch }: SearchToolDeps): Promise<string> {
  const target = searchToolTarget(platform, arch)
  if (!target) throw failure(`No pinned fd and rg for ${platform} on ${arch}.`)
  return installAssets(searchToolAssets(target), { fetch, tar: systemTar(platform, env) })
}

function withToolsOnPath(slot: Slot, dir: string, env: NodeJS.ProcessEnv, platform: string): Slot {
  if (slot.harness !== 'pi') return slot
  const childEnv = { ...env, ...slot.override?.env }
  const key = pathKey(childEnv)
  const path = [dir, childEnv[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':')
  const override = slot.override ?? { args: [], env: {} }
  return { ...slot, override: { ...override, env: { ...override.env, [key]: path } } }
}

const defaultDeps: SearchToolDeps = { env: process.env, platform: process.platform, arch: process.arch, fetch: globalThis.fetch }

export async function withSearchTools<T>(
  slots: ReviewSlots,
  run: (slots: ReviewSlots) => Promise<T>,
  { install = installSearchTools, ...deps }: Partial<SearchToolDeps> & { install?: (deps: SearchToolDeps) => Promise<string> } = {},
): Promise<T> {
  const resolved = { ...defaultDeps, ...deps }
  if (!isCi(resolved.env) || !usesPi(slots)) return run(slots)
  const dir = await install(resolved)
  const onPath = (slot: Slot) => withToolsOnPath(slot, dir, resolved.env, resolved.platform)
  try {
    return await run({
      reviewer1: onPath(slots.reviewer1),
      reviewer2: onPath(slots.reviewer2),
      ...(slots.synthesis ? { synthesis: onPath(slots.synthesis) } : {}),
    })
  } finally {
    removeDir(dir)
  }
}
