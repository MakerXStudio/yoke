import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { lineUi, spinnerUi } from './status'

function fakeTerminal(): { terminal: Writable; output: () => string } {
  const chunks: string[] = []
  const terminal = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString())
      done()
    },
  })
  return { terminal, output: () => chunks.join('') }
}

function run(activity: boolean): string[] {
  const logs: string[] = []
  const status = lineUi((line) => logs.push(line), { activity }).track('claude reviewer')
  status.update('Read src/a.ts')
  status.succeed('claude reviewer done in 3s')
  return logs
}

describe('lineUi', () => {
  it('logs each step as it starts, works and finishes', () => {
    expect(run(true)).toEqual(['claude reviewer…', 'claude reviewer: Read src/a.ts', 'claude reviewer done in 3s'])
  })

  it('leaves out tool activity when asked to', () => {
    expect(run(false)).toEqual(['claude reviewer…', 'claude reviewer done in 3s'])
  })
})

describe('spinnerUi', () => {
  it('shows a running step with its latest activity, then persists how it finished', () => {
    const { terminal, output } = fakeTerminal()
    const ui = spinnerUi(terminal)
    const status = ui.track('codex reviewer')
    status.update('shell rg foo')
    status.fail('codex reviewer failed after 2s: down')
    ui.log('showing the raw reviews instead')
    ui.stop()
    expect(output()).toContain('⠋ codex reviewer')
    expect(output()).toContain('✗ codex reviewer failed after 2s: down')
    expect(output()).toContain('showing the raw reviews instead')
  })
})
