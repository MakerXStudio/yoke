import type { Harness } from './harness'

export type HarnessEvent =
  | { kind: 'activity'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'model'; model: string }
  | { kind: 'ignore' }

const maxSummary = 80

type Json = Record<string, unknown>

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxSummary ? collapsed : `${collapsed.slice(0, maxSummary - 1)}…`
}

function text(input: Json, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

function toolSummary(input: unknown): string {
  if (!isJson(input)) return ''
  const pattern = text(input, 'pattern')
  if (pattern) {
    const scope = text(input, 'path')
    return scope ? `${pattern} in ${scope}` : pattern
  }
  const found = text(input, 'file_path') ?? text(input, 'path') ?? text(input, 'url')
  if (found) return found
  const described = text(input, 'command') ?? text(input, 'query') ?? text(input, 'description')
  return described ? truncate(described) : ''
}

function describeTool(tool: string, summary: string): string {
  return summary ? `${tool} ${summary}` : tool
}

function claudeEvent(event: Json): HarnessEvent {
  if (event.type === 'result' && typeof event.result === 'string') return { kind: 'final', text: event.result }
  if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') return { kind: 'model', model: event.model }
  const content = isJson(event.message) ? event.message.content : undefined
  if (event.type !== 'assistant' || !Array.isArray(content)) return { kind: 'ignore' }
  const uses = content.filter((block): block is Json => isJson(block) && block.type === 'tool_use')
  if (!uses.length) return { kind: 'ignore' }
  return { kind: 'activity', text: uses.map((use) => describeTool(text(use, 'name') ?? 'tool', toolSummary(use.input))).join(', ') }
}

function unwrapShell(command: string): string {
  const wrapped = command.match(/^\/bin\/(?:ba|z)?sh\s+-lc\s+["'](.*)["']\s*$/s)
  return truncate(wrapped?.[1]?.replace(/\\"/g, '"') ?? command)
}

function codexEvent(event: Json): HarnessEvent {
  const item = event.item
  if (event.type !== 'item.started' || !isJson(item)) return { kind: 'ignore' }
  const command = text(item, 'command')
  if (item.type === 'command_execution' && command) return { kind: 'activity', text: describeTool('shell', unwrapShell(command)) }
  return { kind: 'ignore' }
}

export function parseHarnessEvent(harness: Harness, line: string): HarnessEvent {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return { kind: 'ignore' }
  }
  if (!isJson(event)) return { kind: 'ignore' }
  return harness === 'claude' ? claudeEvent(event) : codexEvent(event)
}
