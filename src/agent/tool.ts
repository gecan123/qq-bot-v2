import { z, type ZodTypeAny } from 'zod'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AssistantToolCall, ToolResultContent } from './agent-context.types.js'
import { logToolCall, summarizeToolArgs } from '../ops/tool-call-log.js'
import { stripNullsFromOptionalFields, zodToToolJsonSchema } from './tool-schema.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

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
  /** active Goal 内单调递增的 round；只在主循环执行 Goal 时存在，并跨重启恢复。 */
  goalRoundIndex?: number
}

export interface Tool<TArgs = unknown> {
  name: string
  description: string
  schema: ZodTypeAny
  /** 调度与审计共用的运行时策略；未声明时 fail closed（exclusive + side effect）。 */
  policy?: ToolPolicy
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult>
}

export interface ToolPolicyDecision {
  /** true 时会进入 side_effects 模式的工具审计日志。 */
  sideEffect: boolean
  /** parallel 只允许与同一连续批次里的其他 parallel 调用并发。 */
  concurrency: 'parallel' | 'exclusive'
}

export type ToolPolicy = (args: Record<string, unknown>) => ToolPolicyDecision

export const CONSERVATIVE_TOOL_POLICY: ToolPolicyDecision = Object.freeze({
  sideEffect: true,
  concurrency: 'exclusive',
})

export function classifyToolExecution(
  tool: Tool | undefined,
  args: Record<string, unknown>,
): ToolPolicyDecision {
  return tool?.policy?.(args) ?? CONSERVATIVE_TOOL_POLICY
}

export interface ToolExecutionResult {
  /** 喂给 LLM 的 tool message content。string 或 structured content blocks (含图片)。 */
  content: ToolResultContent
  /** 仅供 runtime / 审计使用，不进入 AgentContext。 */
  outcome?: ToolExecutionOutcome
  /** 工具请求 runtime 执行的声明式动作；不进入 AgentContext。 */
  effects?: ToolEffect[]
}

export type ToolContinuation = 'immediate' | 'wait_attention' | 'backoff' | 'stop'

export interface ToolExecutionOutcome {
  ok: boolean
  code?: string
  error?: string
  /** false 表示调用成功但没有获得新信息、改变状态或完成外部动作。 */
  progress?: boolean
  /** runtime 应如何安排下一次尝试；不进入 durable ledger。 */
  retryClass?: 'immediate' | 'after_event' | 'backoff' | 'terminal'
  /** 与 progress 解耦的续轮建议；元信息读取可以不算进展但仍请求一次立即决策。 */
  continuation?: ToolContinuation
  /** 本次披露的新颖性标识；同一进程内重复 key 会被 runtime 降级为无进展等待。 */
  noveltyKey?: string
  /** 本轮工具实际披露的 messages.id，供旁路 reviewer 构造受控证据 allowlist；不进入 ledger。 */
  evidenceMessageRowIds?: number[]
}

export type MessageSentTarget =
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number }

export type ToolEffect =
  | {
      type: 'pause'
      /** elapsed 只在休息自然到时后产生；旧调用方未携带 status 时不得推断为自然醒。 */
      status?: 'elapsed' | 'interrupted'
    }
  | {
      type: 'message_sent'
      target: MessageSentTarget
    }

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
  /** 对真实调用（包括 deferred invoke 的内部目标）做统一调度/审计分类。 */
  classify(call: AssistantToolCall): ToolPolicyDecision
  /** 翻译 LLM 给的 toolCall (含 id + name + 已 parsed 的 args), 找对应工具执行。 */
  execute(call: AssistantToolCall, ctx: ToolContext): Promise<ToolExecutionResult>
}

export interface ToolTraceOptions {
  path?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
  clockMs?: () => number
  persistToDb?: boolean
  /** all=全部调用; side_effects=只记副作用; off=关闭。未传时保持 all 兼容测试/嵌入方。 */
  mode?: 'all' | 'side_effects' | 'off'
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
  /** 同名工具分属多个 capability 时，按真实 args 选择允许的边界。 */
  acceptsToolCall?: (toolName: string, args: Record<string, unknown>) => boolean
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
    classify(call) {
      return classifyToolExecution(byName.get(call.name), call.args)
    },
    async execute(call, ctx) {
      const startedAt = options.trace ? (options.trace.clockMs?.() ?? Date.now()) : 0
      const tool = byName.get(call.name)
      if (!tool) {
        const error = `Unknown tool: ${call.name}`
        const availableTools = [...byName.keys()]
        const result = {
          content: JSON.stringify({
            ok: false,
            code: 'unknown_tool',
            error,
            availableTools,
            retryable: availableTools.length > 0,
            hint: buildUnknownToolHint(call.name, availableTools),
          }),
          outcome: { ok: false, code: 'unknown_tool', error },
        }
        await traceToolCall(options.trace, call, ctx.roundIndex, startedAt, result, {
          forcedError: error,
        })
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
            retryable: true,
            hint: buildInvalidToolArgumentsHint(call.name),
          }),
          outcome: { ok: false, code: 'invalid_arguments', error },
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, {
          tool,
          forcedError: error,
        })
        return result
      }
      const blocked = await runBeforeToolHooks(options.hooks?.beforeTool ?? [], { ...ctx, tool, call: normalizedCall })
      if (blocked) {
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, blocked, { tool })
        return blocked
      }
      try {
        const result = await tool.execute(parseResult.data as never, ctx)
        await runAfterToolHooks(options.hooks?.afterTool ?? [], { ...ctx, tool, call: normalizedCall, result })
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, { tool })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const error = `Tool execution failed: ${message}`
        const result = {
          content: JSON.stringify({ ok: false, code: 'execution_failed', error }),
          outcome: { ok: false, code: 'execution_failed', error },
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, {
          tool,
          forcedError: error,
        })
        return result
      }
    },
  }
}

function buildUnknownToolHint(toolName: string, availableTools: string[]): string {
  if (toolName === 'send_image') {
    return '不存在 send_image；发送已有图片时改用 send_message，并把 media:<id> 或 ephemeral:<hash> 传给 imageRef。'
  }
  if (toolName === 'workspace_command') {
    return '不存在 workspace_command；只读工作区或仓库时改用 workspace_bash，并提供 cwd 和 command。'
  }
  if (availableTools.length > 0) {
    return '从 availableTools 选择精确工具名；需要 deferred 能力时先用 help describe/activate，再通过 invoke 调用。'
  }
  return '当前执行器没有可用工具；不要继续猜测相似工具名。'
}

function buildInvalidToolArgumentsHint(toolName: string): string {
  if (toolName === 'invoke') {
    return 'invoke.args 必须是参数对象，不要把它放到顶层，也不要传空参数；例如 {"tool":"workspace_file","args":{"action":"read","file":"notes/example.md"}}。'
  }
  if (toolName === 'workspace_file') {
    return '先用 invoke 调用 workspace_file read：{"tool":"workspace_file","args":{"action":"read","file":"notes/example.md"}}；从结果复制 revision，再调用 replace：{"tool":"workspace_file","args":{"action":"replace","file":"notes/example.md","expectedRevision":"<read 返回的 revision>","oldText":"<原文中唯一匹配的文本>","newText":"<新文本>"}}。args 必须是对象。'
  }
  return `根据 issues 和 ${toolName} 的当前 schema 修正参数，然后立即重试同一工具；字段名和参数类型必须精确匹配，不要改用相似但不存在的工具。`
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
    classify(call) {
      if (call.name !== invoke.name) {
        return classifyToolExecution(visibleTools().find((tool) => tool.name === call.name), call.args)
      }
      const parsed = invoke.schema.safeParse(normalizeInvokeToolArgs(call.args))
      if (!parsed.success) return classifyToolExecution(invoke, call.args)
      const invokeArgs = parsed.data as InvokeToolArgs
      const targetArgs = invokeArgs.args ?? {}
      const entries = deferredToolEntriesByName.get(invokeArgs.tool) ?? []
      const entry = entries.find((item) => (
        item.capability.acceptsToolCall?.(invokeArgs.tool, targetArgs) ?? true
      )) ?? entries[0]
      return classifyToolExecution(entry?.tool ?? invoke, targetArgs)
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
    capability: z.string().trim().min(1).optional().describe('action=activate/deactivate 时必填; action=describe 时与 tool 至少提供一个.'),
    tool: z.string().trim().min(1).optional().describe('action=describe 时与 capability 至少提供一个.'),
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
    policy: (args) => ({
      sideEffect: args.action === 'activate' || args.action === 'deactivate',
      concurrency: 'exclusive',
    }),
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
          const requestedEntry = args.capability
            ? entries.find((item) => item.capability.name === args.capability)
            : undefined
          const entry = requestedEntry
            ?? entries.find((item) => activeNames.has(item.capability.name))
            ?? entries[0]!
          const active = activeNames.has(entry.capability.name)
          return {
            content: JSON.stringify({
              ok: true,
              tool: {
                name: entry.tool.name,
                description: entry.tool.description,
                capability: entry.capability.name,
                capabilities: entries.map((item) => item.capability.name),
                active,
                inputSchema: zodToToolJsonSchema(entry.tool.schema),
              },
              next: active
                ? { tool: 'invoke', args: { tool: entry.tool.name, args: {} } }
                : {
                    tool: 'help',
                    args: { action: 'activate', capability: entry.capability.name },
                  },
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
    policy: () => ({ sideEffect: false, concurrency: 'exclusive' }),
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
    normalizeInvokeToolArgs(options.call.args),
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
      { tool: options.invoke },
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
      { tool: options.invoke },
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
      { tool: options.invoke },
    )
    return result
  }

  const matchingEntries = entries.filter((item) => (
    item.capability.acceptsToolCall?.(targetToolName, targetArgs) ?? true
  ))
  const eligibleEntries = matchingEntries.length > 0 ? matchingEntries : entries
  const activeCapabilityNames = new Set(options.activeCapabilities.list())
  const entry = eligibleEntries.find((item) => activeCapabilityNames.has(item.capability.name))
  if (!entry) {
    const capabilities = eligibleEntries.map((item) => item.capability.name)
    const recommendedCapability = capabilities[0] ?? ''
    const action = typeof targetArgs.action === 'string' ? targetArgs.action : null
    const error = `tool ${targetToolName} is not active; activate one of: ${capabilities.join(', ')}`
    const result = {
      content: JSON.stringify({
        ok: false,
        code: 'capability_inactive',
        error,
        tool: targetToolName,
        ...(action ? { action } : {}),
        capabilities,
        next: [
          {
            tool: 'help',
            args: { action: 'activate', capability: recommendedCapability },
          },
          {
            tool: 'invoke',
            args: { tool: targetToolName, args: targetArgs },
          },
        ],
      }),
      outcome: { ok: false, code: 'capability_inactive', error },
    }
    await traceToolCall(
      options.executorOptions.trace,
      normalizedCall,
      options.ctx.roundIndex,
      startedAt,
      result,
      { tool: options.invoke },
    )
    return result
  }

  return createToolExecutor([entry.tool], options.executorOptions).execute(
    { id: options.call.id, name: entry.tool.name, args: targetArgs },
    options.ctx,
  )
}

function normalizeInvokeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.args !== 'string') return args
  try {
    const parsed = JSON.parse(args.args) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return args
    return { ...args, args: parsed as Record<string, unknown> }
  } catch {
    return args
  }
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
  options: { tool?: Tool; forcedError?: string } = {},
): Promise<void> {
  if (!trace) return

  const sideEffect = classifyToolExecution(options.tool, call.args).sideEffect
  if (trace.mode === 'off' || (trace.mode === 'side_effects' && !sideEffect)) return

  const finishedAt = trace.clockMs?.() ?? Date.now()
  const classified = classifyToolResult(result, options.forcedError)
  const entry = {
    ts: formatBeijingIso(trace.now?.() ?? new Date()),
    toolCallId: call.id,
    toolName: call.name,
    roundIndex,
    argsSummary: summarizeToolArgs(call.args),
    durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
    ok: classified.ok,
    sideEffect,
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
