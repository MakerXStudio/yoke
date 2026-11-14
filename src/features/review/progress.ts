import type { Harness } from './harness'
import { parseUsage, type TokenUsage } from './usage'

export type HarnessEvent =
  | { kind: 'activity'; text: string }
  | { kind: 'final'; text: string; usage?: TokenUsage }
  | { kind: 'message'; text: string; stopReason: string; errorMessage?: string; usage?: TokenUsage; model?: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'model'; model: string }
  | { kind: 'error'; message: string }
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

function claudeUsage(raw: unknown): TokenUsage | undefined {
  return parseUsage(raw, {
    input: 'input_tokens',
    output: 'output_tokens',
    cacheRead: 'cache_read_input_tokens',
    cacheWrite: 'cache_creation_input_tokens',
  })
}

function codexUsage(raw: unknown): TokenUsage | undefined {
  const usage = parseUsage(raw, { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens' })
  if (usage?.input !== undefined && usage.cacheRead !== undefined) usage.input = Math.max(0, usage.input - usage.cacheRead)
  return usage
}

function claudeResult(event: Json): HarnessEvent {
  const usage = claudeUsage(event.usage)
  if (typeof event.result === 'string') return usage ? { kind: 'final', text: event.result, usage } : { kind: 'final', text: event.result }
  return usage ? { kind: 'usage', usage } : { kind: 'ignore' }
}

function claudeEvent(event: Json): HarnessEvent {
  if (event.type === 'result') return claudeResult(event)
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

function codexError(event: Json): string | undefined {
  if (event.type === 'error') return text(event, 'message')
  if (event.type === 'turn.failed' && isJson(event.error)) return text(event.error, 'message')
  return undefined
}

function codexEvent(event: Json): HarnessEvent {
  const message = codexError(event)
  if (message) return { kind: 'error', message }
  const usage = event.type === 'turn.completed' ? codexUsage(event.usage) : undefined
  if (usage) return { kind: 'usage', usage }
  const item = event.item
  if (event.type !== 'item.started' || !isJson(item)) return { kind: 'ignore' }
  const command = text(item, 'command')
  if (item.type === 'command_execution' && command) return { kind: 'activity', text: describeTool('shell', unwrapShell(command)) }
  return { kind: 'ignore' }
}

function piUsage(raw: unknown): TokenUsage | undefined {
  return parseUsage(raw, { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite' })
}

function piText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Json => isJson(block) && block.type === 'text')
    .map((block) => text(block, 'text') ?? '')
    .join('\n')
}

function piMessage(message: Json): HarnessEvent {
  const stopReason = text(message, 'stopReason')
  if (message.role !== 'assistant' || !stopReason) return { kind: 'ignore' }
  const usage = piUsage(message.usage)
  const errorMessage = text(message, 'errorMessage')
  const model = text(message, 'model')
  return {
    kind: 'message',
    text: piText(message.content),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
  }
}

function piEvent(event: Json): HarnessEvent {
  if (event.type === 'message_end' && isJson(event.message)) return piMessage(event.message)
  if (event.type === 'tool_execution_start')
    return { kind: 'activity', text: describeTool(text(event, 'toolName') ?? 'tool', toolSummary(event.args)) }
  const usage = event.type === 'compaction_end' && isJson(event.result) ? piUsage(event.result.usage) : undefined
  return usage ? { kind: 'usage', usage } : { kind: 'ignore' }
}

const parsers: Record<Harness, (event: Json) => HarnessEvent> = { claude: claudeEvent, codex: codexEvent, pi: piEvent }

export function parseHarnessEvent(harness: Harness, line: string): HarnessEvent {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return { kind: 'ignore' }
  }
  if (!isJson(event)) return { kind: 'ignore' }
  return parsers[harness](event)
}
