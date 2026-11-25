import { type Instruction, readInstructions, rootInstructions } from './instructions'
import { piReadPath, resolvePath } from './piPaths'

type HookContext = { cwd: string }

type AgentStartEvent = { systemPromptOptions: { contextFiles: Instruction[] } }

type ToolResultContent = { type: string; text?: string }

type ToolResultEvent = { toolName: string; input: Record<string, unknown>; content: ToolResultContent[]; isError: boolean }

export type InstructionHooks = {
  on(event: 'before_agent_start', handler: (event: AgentStartEvent, ctx: HookContext) => void): void
  on(event: 'tool_result', handler: (event: ToolResultEvent, ctx: HookContext) => { content: ToolResultContent[] } | undefined): void
}

function readPath(event: ToolResultEvent, cwd: string): string | undefined {
  const { path } = event.input
  if (event.isError || typeof path !== 'string') return undefined
  if (event.toolName === 'read') return piReadPath(cwd, path)
  if (event.toolName === 'read_range') return resolvePath(cwd, path)
  return undefined
}

// Pi only logs a hook's throw to stderr, which yoke ignores on success, so both hooks swallow errors.
export function loadInstructions(pi: InstructionHooks): void {
  const loaded = new Set<string>()
  let root: Instruction[] | undefined
  pi.on('before_agent_start', (event, ctx) => {
    try {
      root ??= rootInstructions(ctx.cwd, loaded)
      event.systemPromptOptions.contextFiles.push(...root)
    } catch {}
  })
  pi.on('tool_result', (event, ctx) => {
    try {
      const path = readPath(event, ctx.cwd)
      const files = path ? readInstructions(ctx.cwd, path, loaded) : []
      if (!files.length) return undefined
      const blocks = files.map((file) => ({ type: 'text', text: `Contents of ${file.path}:\n\n${file.content}` }))
      return { content: [...event.content, ...blocks] }
    } catch {
      return undefined
    }
  })
}
