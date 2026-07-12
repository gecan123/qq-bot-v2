import { z } from 'zod'
import { createAgentContext } from '../agent-context.js'
import type { BackgroundTaskRegistry, JsonValue } from '../background-task-registry.js'
import type { LlmClient } from '../llm-client.js'
import { runReactRound } from '../react-kernel.js'
import type { TaskScheduler } from '../task-scheduler.js'
import { createToolExecutor, type Tool, type ToolContext } from '../tool.js'

export const DELEGATE_ALLOWED_TOOL_NAMES = [
  'workspace_bash',
  'inbox',
  'qq_directory',
  'chat_style',
  'ai_tone',
  'skill',
  'background_task',
] as const

type DelegateAllowedToolName = typeof DELEGATE_ALLOWED_TOOL_NAMES[number]

const argsSchema = z.object({
  task: z.string().trim().min(1).max(8_000)
    .describe('交给一次性 delegate 的完整任务说明；它看不到主 AgentContext。'),
  allowedTools: z.array(z.enum(DELEGATE_ALLOWED_TOOL_NAMES)).max(5).default([])
    .describe('delegate 可见的只读工具子集；留空表示只做纯 LLM 分析。'),
  maxRounds: z.number().int().min(1).max(8).default(4),
  timeoutSeconds: z.number().int().min(15).max(300).default(120),
})

type RawArgs = z.input<typeof argsSchema>
type Args = z.output<typeof argsSchema>

export interface DelegateToolDeps {
  llm: LlmClient
  taskRegistry: BackgroundTaskRegistry
  taskScheduler: TaskScheduler
  safeTools: readonly Tool[]
}

const DELEGATE_SYSTEM_PROMPT = [
  '你是一次性受限 delegate。你只有当前 user task 和列出的只读工具，没有主 Agent 的历史。',
  '完成调查后必须调用 delegate_return，summary 简洁说明结论，result 给出可直接交给主 Agent 的完整结果。',
  '不得尝试发消息、写记忆、创建定时任务、生成媒体、交易或调用未列出的工具。',
].join('\n')

export function createDelegateTool(deps: DelegateToolDeps): Tool<RawArgs> {
  const safeTools = new Map(
    deps.safeTools
      .filter((tool): tool is Tool & { name: DelegateAllowedToolName } => (
        DELEGATE_ALLOWED_TOOL_NAMES.includes(tool.name as DelegateAllowedToolName)
      ))
      .map((tool) => [tool.name, tool]),
  )

  return {
    name: 'delegate',
    description: [
      '把一个边界清楚的调查/分析任务交给一次性 clean-context delegate，立即返回 taskId。',
      'delegate 只可使用 allowedTools 中的固定只读工具，最多 8 轮、300 秒；没有对外发言或写操作权限。',
      '完成后用 background_task action=get 读取结构化结果。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs) as Args
      const missing = args.allowedTools.filter((name) => !safeTools.has(name))
      if (missing.length > 0) {
        return {
          content: JSON.stringify({
            ok: false,
            code: 'delegate_tool_unavailable',
            unavailableTools: missing,
            availableTools: [...safeTools.keys()],
          }),
          outcome: { ok: false, code: 'delegate_tool_unavailable' },
        }
      }

      const description = `受限委派: ${args.task.slice(0, 120)}`
      const task = deps.taskRegistry.register({ toolName: 'delegate', description })
      void deps.taskScheduler.schedule({ lane: 'delegate' }, async () => {
        await runDelegate({ ...deps, args, ctx, taskId: task.id, description })
      }).catch(() => {
        // runDelegate 已把失败写入 registry 并发布事件；scheduler rejection 不重复终态迁移。
      })

      return {
        content: JSON.stringify({
          ok: true,
          status: 'started',
          taskId: task.id,
          allowedTools: args.allowedTools,
          maxRounds: args.maxRounds,
          timeoutSeconds: args.timeoutSeconds,
          next: `等待完成通知后调用 background_task action=get taskId=${task.id}`,
        }),
        outcome: { ok: true, code: 'started' },
      }
    },
  }
}

async function runDelegate(input: DelegateToolDeps & {
  args: Args
  ctx: ToolContext
  taskId: string
  description: string
}): Promise<void> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('delegate_timeout')),
    input.args.timeoutSeconds * 1000,
  )
  let returned: { summary: string; result: string } | null = null
  let rounds = 0

  const returnTool: Tool = {
    name: 'delegate_return',
    description: '提交最终结果并结束 delegate。',
    schema: z.object({
      summary: z.string().trim().min(1).max(500),
      result: z.string().trim().min(1).max(12_000),
    }),
    async execute(args) {
      returned = args as { summary: string; result: string }
      return { content: JSON.stringify({ ok: true, accepted: true }) }
    },
  }
  const selectedTools = input.args.allowedTools.map((name) => (
    input.safeTools.find((tool) => tool.name === name)!
  ))
  const executor = createToolExecutor([...selectedTools, returnTool])
  const context = createAgentContext()
  context.appendUserMessage(input.args.task)

  try {
    while (!returned && rounds < input.args.maxRounds) {
      if (controller.signal.aborted) throw controller.signal.reason
      rounds++
      await runReactRound({
        systemPrompt: DELEGATE_SYSTEM_PROMPT,
        context,
        llm: input.llm,
        tools: executor,
        toolContext: { eventQueue: input.ctx.eventQueue, roundIndex: rounds },
        signal: controller.signal,
        workingContext: { recentImageToolResults: 0 },
      })
    }
    if (!returned) throw new Error(`delegate_max_rounds_exceeded:${input.args.maxRounds}`)

    const final = returned as { summary: string; result: string }
    const data: JsonValue = {
      summary: final.summary,
      result: final.result,
      rounds,
      allowedTools: input.args.allowedTools,
    }
    input.taskRegistry.complete(input.taskId, { summary: final.summary, data })
    input.ctx.eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: input.taskId,
      toolName: 'delegate',
      description: input.description,
      elapsedMs: Date.now() - startedAt,
      ok: true,
      summary: final.summary,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.taskRegistry.fail(input.taskId, message)
    input.ctx.eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: input.taskId,
      toolName: 'delegate',
      description: input.description,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      summary: message,
    })
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
