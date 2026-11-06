import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

const steps = z
  .object({ jobs: z.object({ release: z.object({ steps: z.array(z.object({ name: z.string(), run: z.string().optional() })) }) }) })
  .parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/workflows/release.yml'), 'utf8'))).jobs.release.steps
const findNewTag = steps.find((step) => step.name === 'Find new tag')?.run ?? ''

describe('release Find new tag', () => {
  let dir: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

  const tag = (name: string) => {
    git('commit', '--allow-empty', '-qm', name)
    git('tag', name)
  }

  const outputs = (tagsBefore: string[]) => {
    writeFileSync(join(dir, 'tags-before'), tagsBefore.map((t) => `${t}\n`).join(''))
    const output = join(dir, 'output')
    writeFileSync(output, '')
    execFileSync('bash', ['-e', '-c', findNewTag], { cwd: dir, env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output } })
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-lock-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('locks a newly released tag', () => {
    tag('v1.0.0')
    tag('review-v1.0.0')
    tag('v1.1.0')
    expect(outputs(['v1.0.0'])).toEqual({ tag: 'v1.1.0', lock: 'v1.1.0' })
  })

  it('retries the lock of the latest release when its review tag is missing', () => {
    tag('v1.9.0')
    tag('review-v1.9.0')
    tag('v1.10.0')
    expect(outputs(['v1.9.0', 'v1.10.0'])).toEqual({ tag: '', lock: 'v1.10.0' })
  })

  it('locks nothing when no release is new and the latest is locked', () => {
    tag('v1.0.0')
    tag('review-v1.0.0')
    expect(outputs(['v1.0.0'])).toEqual({ tag: '', lock: '' })
  })

  it('locks nothing before the first release', () => {
    git('commit', '--allow-empty', '-qm', 'initial')
    expect(outputs([])).toEqual({ tag: '', lock: '' })
  })
})
