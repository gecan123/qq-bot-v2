import { z, type ZodTypeAny } from 'zod'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AssistantToolCall, ToolResultContent } from './agent-context.types.js'
import { isSideEffectTool, logToolCall, summarizeToolArgs } from '../ops/tool-call-log.js'
import { stripNullsFromOptionalFields, zodToToolJsonSchema } from './tool-schema.js'
import { createLogger } from '../logger.js'

const log = createLogger('TOOL_EXECUTOR')

/**
 * Tool 接口最简形:name + description + 参数 schema + execute。
 * 运行时动作通过 ToolExecutionResult.effects 声明，再由 EffectInterpreter 解释。
 *
 * execute 失败 (抛异常) 由调用方 (BotLoopAgent) catch 后写一条 tool result content 表示
 * 失败,而不是把异常向外冒泡——保证 round 不会因为单个 tool 抛异常而崩溃。
 */
export interface ToolContext {
  eventQueue: EventQueue<BotEvent>
  /** 当前 round 的元信息,用于工具内日志。 */
  roundIndex: number
}

export interface Tool<TArgs = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult>
}

export interface ToolExecutionResult {
  /** 喂给 LLM 的 tool message content。string 或 structured content blocks (含图片)。 */
  content: ToolResultContent
  /** 仅供 runtime / 审计使用，不进入 AgentContext。 */
  outcome?: ToolExecutionOutcome
  /** 工具请求 runtime 执行的声明式动作；不进入 AgentContext。 */
  effects?: ToolEffect[]
}

export interface ToolExecutionOutcome {
  ok: boolean
  code?: string
  error?: string
}

export type ToolEffect = { type: 'pause' }

export interface ToolHookContext extends ToolContext {
  tool: Tool
  call: AssistantToolCall
}

export type BeforeToolHook = (
  ctx: ToolHookContext,
) => Promise<ToolExecutionResult | void> | ToolExecutionResult | void

export type AfterToolHook = (
  ctx: ToolHookContext & { result: ToolExecutionResult },
) => Promise<void> | void

export interface ToolExecutor {
  list(): Tool[]
  /** 翻译 LLM 给的 toolCall (含 id + name + 已 parsed 的 args), 找对应工具执行。 */
  execute(call: AssistantToolCall, ctx: ToolContext): Promise<ToolExecutionResult>
}

export interface ToolTraceOptions {
  path?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
  clockMs?: () => number
  persistToDb?: boolean
}

export interface ToolExecutorOptions {
  trace?: ToolTraceOptions
  hooks?: {
    beforeTool?: BeforeToolHook[]
    afterTool?: AfterToolHook[]
  }
}

export interface DeferredToolCapability {
  name: string
  description: string
  tools: Tool[]
}

export interface ActiveToolCapabilityState {
  list(): string[]
  activate(capability: string): void
  deactivate(capability: string): void
}

export interface DeferredToolExecutorOptions extends ToolExecutorOptions {
  alwaysOnTools: Tool[]
  capabilities: DeferredToolCapability[]
  activeCapabilities?: ActiveToolCapabilityState
}

export function createToolExecutor(tools: Tool[], options: ToolExecutorOptions = {}): ToolExecutor {
  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`)
    }
    byName.set(tool.name, tool)
  }

  return {
    list() {
      return [...tools]
    },
    async execute(call, ctx) {
      const startedAt = options.trace ? (options.trace.clockMs?.() ?? Date.now()) : 0
      const tool = byName.get(call.name)
      if (!tool) {
        const error = `Unknown tool: ${call.name}`
        const result = {
          content: JSON.stringify({ ok: false, code: 'unknown_tool', error }),
          outcome: { ok: false, code: 'unknown_tool', error },
        }
        await traceToolCall(options.trace, call, ctx.roundIndex, startedAt, result, error)
        return result
      }
      const normalizedArgs = stripNullsFromOptionalFields(tool.schema, call.args) as Record<string, unknown>
      const normalizedCall = { ...call, args: normalizedArgs }
      const parseResult = tool.schema.safeParse(normalizedArgs)
      if (!parseResult.success) {
        const error = 'Invalid tool arguments'
        const result = {
          content: JSON.stringify({
            ok: false,
            code: 'invalid_arguments',
            error,
            issues: parseResult.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          }),
          outcome: { ok: false, code: 'invalid_arguments', error },
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, error)
        return result
      }
      const blocked = await runBeforeToolHooks(options.hooks?.beforeTool ?? [], { ...ctx, tool, call: normalizedCall })
      if (blocked) {
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, blocked)
        return blocked
      }
      try {
        const result = await tool.execute(parseResult.data as never, ctx)
        await runAfterToolHooks(options.hooks?.afterTool ?? [], { ...ctx, tool, call: normalizedCall, result })
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const error = `Tool execution failed: ${message}`
        const result = {
          content: JSON.stringify({ ok: false, code: 'execution_failed', error }),
          outcome: { ok: false, code: 'execution_failed', error },
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, error)
        return result
      }
    },
  }
}

export function createDeferredToolExecutor(options: DeferredToolExecutorOptions): ToolExecutor {
  const capabilityByName = new Map<string, DeferredToolCapability>()
  const deferredToolEntriesByName = new Map<string, DeferredToolEntry[]>()
  const localActiveCapabilities = new Set<string>()
  const activeCapabilities = options.activeCapabilities ?? {
    list: () => [...localActiveCapabilities],
    activate: (capability: string) => {
      localActiveCapabilities.add(capability)
    },
    deactivate: (capability: string) => {
      localActiveCapabilities.delete(capability)
    },
  }

  for (const capability of options.capabilities) {
    if (capabilityByName.has(capability.name)) {
      throw new Error(`Duplicate deferred capability: ${capability.name}`)
    }
    capabilityByName.set(capability.name, capability)
    for (const tool of capability.tools) {
      const entries = deferredToolEntriesByName.get(tool.name) ?? []
      entries.push({ capability, tool })
      deferredToolEntriesByName.set(tool.name, entries)
    }
  }

  const help = createHelpTool({
    capabilities: options.capabilities,
    activeCapabilities,
    deferredToolEntriesByName,
  })
  const invoke = createInvokeTool()

  function visibleTools(): Tool[] {
    const byName = new Map<string, Tool>()
    for (const tool of options.alwaysOnTools) byName.set(tool.name, tool)
    byName.set(help.name, help)
    byName.set(invoke.name, invoke)
    return [...byName.values()]
  }

  return {
    list() {
      return visibleTools()
    },
    execute(call, ctx) {
      if (call.name === invoke.name) {
        return executeInvokeToolCall({
          call,
          ctx,
          invoke,
          deferredToolEntriesByName,
          activeCapabilities,
          executorOptions: options,
        })
      }
      return createToolExecutor(visibleTools(), options).execute(call, ctx)
    },
  }
}

interface DeferredToolEntry {
  capability: DeferredToolCapability
  tool: Tool
}

type HelpToolArgs = {
  action: 'list' | 'activate' | 'deactivate' | 'describe'
  capability?: string
  tool?: string
}

type InvokeToolArgs = {
  tool: string
  args?: Record<string, unknown>
}

function createHelpTool(options: {
  capabilities: DeferredToolCapability[]
  activeCapabilities: ActiveToolCapabilityState
  deferredToolEntriesByName: Map<string, DeferredToolEntry[]>
}): Tool<HelpToolArgs> {
  const capabilityByName = new Map(options.capabilities.map((capability) => [capability.name, capability]))
  const capabilityNames = options.capabilities.map((capability) => capability.name).join(', ')
  const schema = z.object({
    action: z.enum(['list', 'activate', 'deactivate', 'describe']).describe('list=查看能力; activate=允许 invoke 调用该 capability; deactivate=收起能力; describe=按需查看 capability 或 tool 说明.'),
    capability: z.string().trim().min(1).optional().describe('要激活或收起的 capability 名称.'),
    tool: z.string().trim().min(1).optional().describe('describe 时要查看的内部工具名.'),
  }).superRefine((args, ctx) => {
    if ((args.action === 'activate' || args.action === 'deactivate') && !args.capability) {
      ctx.addIssue({
        code: 'custom',
        path: ['capability'],
        message: 'capability is required for activate/deactivate',
      })
    }
    if (args.action === 'describe' && !args.capability && !args.tool) {
      ctx.addIssue({
        code: 'custom',
        path: ['tool'],
        message: 'capability or tool is required for describe',
      })
    }
  })

  return {
    name: 'help',
    description: [
      '稳定工具帮助入口. 用 list 查看可激活 capability; 用 describe 按需查看内部工具 schema; 用 activate 后再通过 invoke 调用内部工具.',
      `可用 capability: ${capabilityNames || 'none'}.`,
      '顶层 tools 不会因 activate/deactivate 改变.',
    ].join(' '),
    schema,
    async execute(args) {
      if (args.action === 'list') {
        return {
          content: JSON.stringify({
            ok: true,
            capabilities: options.capabilities.map((capability) => ({
              name: capability.name,
              description: capability.description,
              active: options.activeCapabilities.list().includes(capability.name),
              tools: capability.tools.map((tool) => tool.name),
            })),
            next: '需要某个工具的参数时调用 help action=describe tool=<tool>; 需要使用时先 activate capability, 再 invoke tool=<tool> args=<object>.',
          }),
        }
      }

      if (args.action === 'describe') {
        if (args.tool) {
          const entries = options.deferredToolEntriesByName.get(args.tool) ?? []
          if (entries.length === 0) {
            return {
              content: JSON.stringify({
                ok: false,
                code: 'unknown_tool',
                error: `unknown deferred tool: ${args.tool}`,
                tools: [...options.deferredToolEntriesByName.keys()],
              }),
              outcome: { ok: false, code: 'unknown_tool', error: `unknown deferred tool: ${args.tool}` },
            }
          }
          const activeNames = new Set(options.activeCapabilities.list())
          const entry = entries.find((item) => activeNames.has(item.capability.name)) ?? entries[0]!
          return {
            content: JSON.stringify({
              ok: true,
              tool: {
                name: entry.tool.name,
                description: entry.tool.description,
                capability: entry.capability.name,
                capabilities: entries.map((item) => item.capability.name),
                active: entries.some((item) => activeNames.has(item.capability.name)),
                inputSchema: zodToToolJsonSchema(entry.tool.schema),
              },
              next: activeNames.has(entry.capability.name)
                ? `invoke tool=${entry.tool.name} args=<object>`
                : `help action=activate capability=${entry.capability.name}`,
            }),
          }
        }

        const capability = args.capability ? capabilityByName.get(args.capability) : null
        if (!capability) {
          return {
            content: JSON.stringify({
              ok: false,
              code: 'unknown_capability',
              error: `unknown capability: ${args.capability ?? ''}`,
              capabilities: options.capabilities.map((item) => item.name),
            }),
            outcome: { ok: false, code: 'unknown_capability', error: `unknown capability: ${args.capability ?? ''}` },
          }
        }
        return {
          content: JSON.stringify({
            ok: true,
            capability: {
              name: capability.name,
              description: capability.description,
              active: options.activeCapabilities.list().includes(capability.name),
              tools: capability.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
              })),
            },
            next: '需要参数 schema 时调用 help action=describe tool=<tool>.',
          }),
        }
      }

      const capability = args.capability ? capabilityByName.get(args.capability) : null
      if (!capability) {
        return {
          content: JSON.stringify({
            ok: false,
            code: 'unknown_capability',
            error: `unknown capability: ${args.capability ?? ''}`,
            capabilities: options.capabilities.map((item) => item.name),
          }),
          outcome: { ok: false, code: 'unknown_capability', error: `unknown capability: ${args.capability ?? ''}` },
        }
      }

      if (args.action === 'activate') {
        options.activeCapabilities.activate(capability.name)
        return {
          content: JSON.stringify({
            ok: true,
            action: 'activate',
            capability: capability.name,
            message: `${capability.name} 已激活; 现在可通过 invoke 调用内部工具: ${capability.tools.map((tool) => tool.name).join(', ')}`,
          }),
        }
      }

      options.activeCapabilities.deactivate(capability.name)
      return {
        content: JSON.stringify({
          ok: true,
          action: 'deactivate',
          capability: capability.name,
          message: `${capability.name} 已收起`,
        }),
      }
    },
  }
}

function createInvokeTool(): Tool<InvokeToolArgs> {
  return {
    name: 'invoke',
    description: '稳定内部工具调用入口. 先用 help list/describe/activate 发现能力; 只能调用已激活 capability 中的内部工具.',
    schema: z.object({
      tool: z.string().trim().min(1).describe('要调用的内部工具名, 例如 browser、web_search、fetch_content、generate_image、openbb_cli.'),
      args: z.record(z.string(), z.unknown()).optional().describe('内部工具参数对象. 具体字段先用 help action=describe tool=<tool> 查看.'),
    }),
    async execute(args) {
      return { content: JSON.stringify({ ok: true, tool: args.tool }) }
    },
  }
}

async function executeInvokeToolCall(options: {
  call: AssistantToolCall
  ctx: ToolContext
  invoke: Tool<InvokeToolArgs>
  deferredToolEntriesByName: Map<string, DeferredToolEntry[]>
  activeCapabilities: ActiveToolCapabilityState
  executorOptions: DeferredToolExecutorOptions
}): Promise<ToolExecutionResult> {
  const startedAt = options.executorOptions.trace
    ? (options.executorOptions.trace.clockMs?.() ?? Date.now())
    : 0
  const normalizedArgs = stripNullsFromOptionalFields(
    options.invoke.schema,
    options.call.args,
  ) as Record<string, unknown>
  const normalizedCall = { ...options.call, args: normalizedArgs }
  const shellResult = await createToolExecutor([options.invoke]).execute(normalizedCall, options.ctx)
  if (!isSuccessfulToolResult(shellResult)) {
    await traceToolCall(
      options.executorOptions.trace,
      normalizedCall,
      options.ctx.roundIndex,
      startedAt,
      shellResult,
    )
    return shellResult
  }

  const parseResult = options.invoke.schema.safeParse(normalizedArgs)
  if (!parseResult.success) {
    await traceToolCall(
      options.executorOptions.trace,
      normalizedCall,
      options.ctx.roundIndex,
      startedAt,
      shellResult,
    )
    return shellResult
  }

  const invokeArgs = parseResult.data as InvokeToolArgs
  const targetToolName = invokeArgs.tool
  const targetArgs = invokeArgs.args ?? {}
  const entries = options.deferredToolEntriesByName.get(targetToolName) ?? []
  if (entries.length === 0) {
    const error = `unknown deferred tool: ${targetToolName}`
    const result = {
      content: JSON.stringify({
        ok: false,
        code: 'unknown_tool',
        error,
        tools: [...options.deferredToolEntriesByName.keys()],
      }),
      outcome: { ok: false, code: 'unknown_tool', error },
    }
    await traceToolCall(
      options.executorOptions.trace,
      normalizedCall,
      options.ctx.roundIndex,
      startedAt,
      result,
    )
    return result
  }

  const activeCapabilityNames = new Set(options.activeCapabilities.list())
  const entry = entries.find((item) => activeCapabilityNames.has(item.capability.name))
  if (!entry) {
    const capabilities = entries.map((item) => item.capability.name)
    const error = `tool ${targetToolName} is not active; activate one of: ${capabilities.join(', ')}`
    const result = {
      content: JSON.stringify({
        ok: false,
        code: 'capability_inactive',
        error,
        tool: targetToolName,
        capabilities,
        next: `help action=activate capability=${capabilities[0] ?? ''}`,
      }),
      outcome: { ok: false, code: 'capability_inactive', error },
    }
    await traceToolCall(
      options.executorOptions.trace,
      normalizedCall,
      options.ctx.roundIndex,
      startedAt,
      result,
    )
    return result
  }

  return createToolExecutor([entry.tool], options.executorOptions).execute(
    { id: options.call.id, name: entry.tool.name, args: targetArgs },
    options.ctx,
  )
}

function isSuccessfulToolResult(result: ToolExecutionResult): boolean {
  if (result.outcome) return result.outcome.ok
  if (typeof result.content !== 'string') return true
  try {
    const parsed = JSON.parse(result.content) as unknown
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      return (parsed as { ok?: unknown }).ok !== false
    }
  } catch {
    return true
  }
  return true
}

async function runBeforeToolHooks(
  hooks: BeforeToolHook[],
  ctx: ToolHookContext,
): Promise<ToolExecutionResult | null> {
  for (const hook of hooks) {
    try {
      const blocked = await hook(ctx)
      if (blocked) return blocked
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error = `Tool hook failed: ${message}`
      return {
        content: JSON.stringify({ ok: false, code: 'hook_failed', error }),
        outcome: { ok: false, code: 'hook_failed', error },
      }
    }
  }
  return null
}

async function runAfterToolHooks(
  hooks: AfterToolHook[],
  ctx: ToolHookContext & { result: ToolExecutionResult },
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(ctx)
    } catch (err) {
      log.warn({ err, toolName: ctx.call.name, toolCallId: ctx.call.id }, 'after_tool_hook_failed')
    }
  }
}

async function traceToolCall(
  trace: ToolTraceOptions | undefined,
  call: AssistantToolCall,
  roundIndex: number,
  startedAt: number,
  result: ToolExecutionResult,
  forcedError?: string,
): Promise<void> {
  if (!trace) return

  const finishedAt = trace.clockMs?.() ?? Date.now()
  const classified = classifyToolResult(result, forcedError)
  const entry = {
    ts: (trace.now?.() ?? new Date()).toISOString(),
    toolCallId: call.id,
    toolName: call.name,
    roundIndex,
    argsSummary: summarizeToolArgs(call.args),
    durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
    ok: classified.ok,
    sideEffect: isSideEffectTool(call.name, call.args),
    ...(classified.error ? { error: classified.error } : {}),
  }
  await logToolCall(entry, { path: trace.path, appender: trace.appender })
  if (trace.persistToDb) {
    import('../ops/agent-observability-db.js')
      .then(({ recordAgentToolCallEvent }) => recordAgentToolCallEvent(entry))
      .catch((err) => {
        log.warn({ err, toolName: call.name, toolCallId: call.id }, 'agent_tool_call_db_writer_load_failed')
      })
  }
}

function classifyToolResult(
  result: ToolExecutionResult,
  forcedError?: string,
): { ok: boolean; error?: string } {
  if (forcedError) return { ok: false, error: forcedError }
  if (result.outcome) {
    return {
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error ?? result.outcome.code ?? 'Tool returned ok=false' }
        : {}),
    }
  }
  if (typeof result.content !== 'string') return { ok: true }
  try {
    const parsed = JSON.parse(result.content) as unknown
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.ok === 'boolean') {
        return {
          ok: obj.ok,
          ...(obj.ok ? {} : { error: typeof obj.error === 'string' ? obj.error : 'Tool returned ok=false' }),
        }
      }
      if (typeof obj.error === 'string') return { ok: false, error: obj.error }
    }
  } catch {
    // Non-JSON string content is a normal successful tool result.
  }
  return { ok: true }
}

// re-export z for convenience
export type { z }
