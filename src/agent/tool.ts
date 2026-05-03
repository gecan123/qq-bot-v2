import type { ZodTypeAny, z } from 'zod'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AssistantToolCall } from './agent-context.types.js'

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
  /** 喂给 LLM 的 tool message content (一段字符串 / JSON 序列化)。 */
  content: string
}

export interface ToolExecutor {
  list(): Tool[]
  /** 翻译 LLM 给的 toolCall (含 id + name + 已 parsed 的 args), 找对应工具执行。 */
  execute(call: AssistantToolCall, ctx: ToolContext): Promise<ToolExecutionResult>
}

export function createToolExecutor(tools: Tool[]): ToolExecutor {
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
      const tool = byName.get(call.name)
      if (!tool) {
        return {
          content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        }
      }
      const parseResult = tool.schema.safeParse(call.args)
      if (!parseResult.success) {
        return {
          content: JSON.stringify({
            error: 'Invalid tool arguments',
            issues: parseResult.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          }),
        }
      }
      try {
        return await tool.execute(parseResult.data as never, ctx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: JSON.stringify({ error: `Tool execution failed: ${message}` }),
        }
      }
    },
  }
}

// re-export z for convenience
export type { z }
