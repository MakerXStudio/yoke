import { describe, expect, it } from 'vitest'

import { parseHarnessEvent } from './progress'

const line = (event: unknown) => JSON.stringify(event)

describe('parseHarnessEvent', () => {
  it('reports each claude tool call with what it touched', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
        ],
      },
    }
    expect(parseHarnessEvent('claude', line(event))).toEqual({ kind: 'activity', text: 'Read src/a.ts, Grep TODO in src' })
  })

  it("takes claude's final review from the result event", () => {
    expect(parseHarnessEvent('claude', line({ type: 'result', result: '## Findings' }))).toEqual({ kind: 'final', text: '## Findings' })
  })

  it('reports a codex command with its shell wrapper removed', () => {
    const event = { type: 'item.started', item: { type: 'command_execution', command: '/bin/bash -lc "rg -n foo src"' } }
    expect(parseHarnessEvent('codex', line(event))).toEqual({ kind: 'activity', text: 'shell rg -n foo src' })
  })

  it('truncates long summaries', () => {
    const event = { type: 'item.started', item: { type: 'command_execution', command: `echo ${'x'.repeat(200)}` } }
    const parsed = parseHarnessEvent('codex', line(event))
    expect(parsed.kind === 'activity' && parsed.text.length).toBe('shell '.length + 80)
  })

  it.each([
    ['claude', 'not json'],
    ['claude', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })],
    ['codex', line({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } })],
  ] as const)('ignores %s %s', (harness, input) => {
    expect(parseHarnessEvent(harness, input)).toEqual({ kind: 'ignore' })
  })
})
