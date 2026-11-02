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

  it('reads the model claude runs from its init event', () => {
    expect(parseHarnessEvent('claude', line({ type: 'system', subtype: 'init', model: 'claude-opus-4-1' }))).toEqual({
      kind: 'model',
      model: 'claude-opus-4-1',
    })
  })

  it("takes claude's final review from the result event", () => {
    expect(parseHarnessEvent('claude', line({ type: 'result', result: '## Findings' }))).toEqual({ kind: 'final', text: '## Findings' })
  })

  it('reads token usage from the claude result event', () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }
    expect(parseHarnessEvent('claude', line({ type: 'result', result: 'done', usage }))).toEqual({
      kind: 'final',
      text: 'done',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    })
  })

  it('keeps only the claude usage values that were reported', () => {
    expect(parseHarnessEvent('claude', line({ type: 'result', result: 'done', usage: { output_tokens: 5 } }))).toEqual({
      kind: 'final',
      text: 'done',
      usage: { output: 5 },
    })
  })

  it('reads token usage from a codex turn.completed event, with no cache write', () => {
    const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 }
    expect(parseHarnessEvent('codex', line({ type: 'turn.completed', usage }))).toEqual({
      kind: 'usage',
      usage: { input: 100, output: 7, cacheRead: 60 },
    })
  })

  it('reports a codex command with its shell wrapper removed', () => {
    const event = { type: 'item.started', item: { type: 'command_execution', command: '/bin/bash -lc "rg -n foo src"' } }
    expect(parseHarnessEvent('codex', line(event))).toEqual({ kind: 'activity', text: 'shell rg -n foo src' })
  })

  it.each([[{ type: 'error', message: 'unexpected status 401' }], [{ type: 'turn.failed', error: { message: 'unexpected status 401' } }]])(
    'reports the message of a codex %o event',
    (event) => {
      expect(parseHarnessEvent('codex', line(event))).toEqual({ kind: 'error', message: 'unexpected status 401' })
    },
  )

  it('truncates long summaries', () => {
    const event = { type: 'item.started', item: { type: 'command_execution', command: `echo ${'x'.repeat(200)}` } }
    const parsed = parseHarnessEvent('codex', line(event))
    expect(parsed.kind === 'activity' && parsed.text.length).toBe('shell '.length + 80)
  })

  it.each([
    ['claude', 'not json'],
    ['claude', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })],
    ['codex', line({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } })],
    ['codex', line({ type: 'turn.completed', usage: { input_tokens: 'many' } })],
    ['claude', line({ type: 'result', subtype: 'error_max_turns' })],
  ] as const)('ignores %s %s', (harness, input) => {
    expect(parseHarnessEvent(harness, input)).toEqual({ kind: 'ignore' })
  })
})
