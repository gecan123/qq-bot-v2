import type { ZodTypeAny, z } from 'zod'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AssistantToolCall, ToolResultContent } from './agent-context.types.js'
import { isSideEffectTool, logToolCall, summarizeToolArgs } from '../ops/tool-call-log.js'
import { stripNullsFromOptionalFields } from './tool-schema.js'
import { createLogger } from '../logger.js'

const log = createLogger('TOOL_EXECUTOR')

/**
 * Tool 接口最简形:name + description + 参数 schema + execute。
 * 不区分 control / business / kind, 必要时再加。
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
  /** 翻译 LLM 给的 toolCall (含 id + name + 已 parsed 的 args), 找对应工具执行。 */
  execute(call: AssistantToolCall, ctx: ToolContext): Promise<ToolExecutionResult>
}

export interface ToolTraceOptions {
  path?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
  clockMs?: () => number
}

export interface ToolExecutorOptions {
  trace?: ToolTraceOptions
  hooks?: {
    beforeTool?: BeforeToolHook[]
    afterTool?: AfterToolHook[]
  }
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
        const result = {
          content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        }
        await traceToolCall(options.trace, call, ctx.roundIndex, startedAt, result, `Unknown tool: ${call.name}`)
        return result
      }
      const normalizedArgs = stripNullsFromOptionalFields(tool.schema, call.args) as Record<string, unknown>
      const normalizedCall = { ...call, args: normalizedArgs }
      const parseResult = tool.schema.safeParse(normalizedArgs)
      if (!parseResult.success) {
        const result = {
          content: JSON.stringify({
            error: 'Invalid tool arguments',
            issues: parseResult.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          }),
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, 'Invalid tool arguments')
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
        const result = {
          content: JSON.stringify({ error: `Tool execution failed: ${message}` }),
        }
        await traceToolCall(options.trace, normalizedCall, ctx.roundIndex, startedAt, result, `Tool execution failed: ${message}`)
        return result
      }
    },
  }
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
      return { content: JSON.stringify({ error: `Tool hook failed: ${message}` }) }
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
  await logToolCall(
    {
      ts: (trace.now?.() ?? new Date()).toISOString(),
      toolCallId: call.id,
      toolName: call.name,
      roundIndex,
      argsSummary: summarizeToolArgs(call.args),
      durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
      ok: classified.ok,
      sideEffect: isSideEffectTool(call.name, call.args),
      ...(classified.error ? { error: classified.error } : {}),
    },
    { path: trace.path, appender: trace.appender },
  )
}

function classifyToolResult(
  result: ToolExecutionResult,
  forcedError?: string,
): { ok: boolean; error?: string } {
  if (forcedError) return { ok: false, error: forcedError }
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
