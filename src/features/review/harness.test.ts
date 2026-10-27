import { describe, expect, it } from 'vitest'

import { harnessArgs, type HarnessRun } from './harness'

const run: HarnessRun = { harness: 'codex', prompt: 'p', cwd: '/repo', reviewDir: '/review', outputPath: '/review/out.md' }

describe('harnessArgs', () => {
  it('runs codex read-only on stdin with no overrides by default', () => {
    expect(harnessArgs(run)).toEqual(['exec', '--sandbox', 'read-only', '--output-last-message', '/review/out.md', '-'])
  })

  it('puts codex provider overrides before the stdin marker', () => {
    expect(harnessArgs({ ...run, override: { args: ['-m', 'gpt-5-codex'], env: {} } }).slice(-3)).toEqual(['-m', 'gpt-5-codex', '-'])
  })

  it('appends claude provider overrides', () => {
    expect(harnessArgs({ ...run, harness: 'claude', override: { args: ['--model', 'sonnet'], env: {} } })).toEqual([
      '-p',
      '--add-dir',
      '/review',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
      '--model',
      'sonnet',
    ])
  })
})
