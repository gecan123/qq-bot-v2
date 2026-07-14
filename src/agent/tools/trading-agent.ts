import { z } from 'zod'
import { config, type VibeTradingConfig } from '../../config/index.js'
import { createLogger } from '../../logger.js'
import type { BackgroundTaskRegistry, JsonValue } from '../background-task-registry.js'
import type { Tool, ToolContext } from '../tool.js'

const log = createLogger('TOOL_TRADING_AGENT')
const API_RESPONSE_MAX_CHARS = 1_000_000
const ERROR_PREVIEW_CHARS = 800

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start').describe('创建独立 Vibe-Trading session 并异步执行一次研究或回测任务.'),
    prompt: z.string().trim().min(1).max(5_000).describe('要委派给交易研究子 Agent 的自然语言任务.'),
  }),
  z.object({
    action: z.literal('continue').describe('在已有 Vibe-Trading session 中继续追问或迭代.'),
    sessionId: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(5_000),
  }),
  z.object({
    action: z.enum(['status', 'result']).describe('查询 session 当前状态或读取最近一次完整结果.'),
    sessionId: z.string().trim().min(1).max(200),
    attemptId: z.string().trim().min(1).max(200).optional().describe('可选; 指定某次 attempt, 不传则读取最近一次.'),
  }),
  z.object({
    action: z.literal('cancel').describe('取消 session 当前正在运行的研究任务.'),
    sessionId: z.string().trim().min(1).max(200),
  }),
])

type Args = z.infer<typeof argsSchema>
type FetchLike = typeof fetch

interface SessionResponse {
  session_id: string
  last_attempt_id?: string | null
}

interface SendResponse {
  message_id: string
  attempt_id: string
}

interface SessionMessage {
  role: string
  content: string
  linked_attempt_id?: string | null
  metadata?: {
    status?: string
    run_id?: string
    metrics?: unknown
  } | null
}

interface AttemptView {
  sessionId: string
  attemptId: string | null
  status: 'running' | 'completed' | 'failed'
  result?: string
  truncated?: boolean
  runId?: string
  metrics?: JsonValue
}

export interface TradingAgentDeps {
  taskRegistry: BackgroundTaskRegistry
  runtimeConfig?: VibeTradingConfig
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  clockMs?: () => number
}

export function maybeCreateTradingAgentTool(deps: TradingAgentDeps): Tool<Args> | undefined {
  const runtimeConfig = deps.runtimeConfig ?? config.vibeTrading
  if (!runtimeConfig) return undefined
  return createTradingAgentTool({ ...deps, runtimeConfig })
}

export function createTradingAgentTool(
  deps: TradingAgentDeps & { runtimeConfig: VibeTradingConfig },
): Tool<Args> {
  const client = createVibeClient(deps.runtimeConfig, deps.fetchImpl ?? fetch)
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const clockMs = deps.clockMs ?? (() => Date.now())

  return {
    name: 'trading_agent',
    description: [
      '已有具体金融问题，需要跨来源取证、形成可复现策略规则、寻找反证或做历史回测时，委派给本机独立运行的 Vibe-Trading 子 Agent.',
      '它不是行情查询快捷方式: 简单价格数据优先用 openbb_cli; 需要多步研究、生成策略、回测或延续同一研究 session 时再用本工具.',
      'action=start/continue 会异步执行并返回 taskId、sessionId、attemptId; 完成通知到达后可用 background_task get 取结果.',
      'qq-bot 重启导致内存 task 丢失时, 仍可凭 sessionId 调 status/result 从 Vibe-Trading 持久 session 恢复.',
      '固定只允许研究、回测和模拟分析; 不允许真实下单、撤单、券商授权、资金划转或对外发送消息.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)

      if (args.action === 'cancel') {
        const response = await client.request<Record<string, unknown>>(
          `/sessions/${encodeURIComponent(args.sessionId)}/cancel`,
          { method: 'POST' },
        )
        return {
          content: JSON.stringify({ ok: true, action: 'cancel', sessionId: args.sessionId, response }),
          outcome: { ok: true },
        }
      }

      if (args.action === 'status' || args.action === 'result') {
        const view = await loadAttemptView(client, args.sessionId, args.attemptId, deps.runtimeConfig.resultMaxChars)
        return {
          content: JSON.stringify({ ok: true, action: args.action, ...view }),
          outcome: { ok: true },
        }
      }

      if (!('prompt' in args)) {
        throw new Error(`Unsupported trading_agent action: ${args.action}`)
      }

      let sessionId: string
      if (args.action === 'start') {
        const session = await client.request<SessionResponse>('/sessions', {
          method: 'POST',
          body: JSON.stringify({ title: buildSessionTitle(args.prompt) }),
        })
        sessionId = requireString(session.session_id, 'session_id')
      } else {
        sessionId = args.sessionId
      }

      const sent = await client.request<SendResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: boundedResearchPrompt(args.prompt) }),
      })
      const attemptId = requireString(sent.attempt_id, 'attempt_id')
      const description = `Vibe-Trading 研究: ${args.prompt.slice(0, 100)}`
      const task = deps.taskRegistry.register({ toolName: 'trading_agent', description })
      void monitorAttempt({
        client,
        runtimeConfig: deps.runtimeConfig,
        taskRegistry: deps.taskRegistry,
        taskId: task.id,
        sessionId,
        attemptId,
        description,
        ctx,
        sleep,
        clockMs,
      })

      return {
        content: JSON.stringify({
          ok: true,
          action: args.action,
          status: 'started',
          taskId: task.id,
          sessionId,
          attemptId,
          next: `等待完成通知后调用 background_task action=get taskId=${task.id}; 重启后调用 trading_agent action=result sessionId=${sessionId} attemptId=${attemptId}`,
        }),
        outcome: { ok: true },
      }
    },
  }
}

function createVibeClient(runtimeConfig: VibeTradingConfig, fetchImpl: FetchLike) {
  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), runtimeConfig.requestTimeoutMs)
      try {
        const headers = new Headers(init.headers)
        headers.set('Accept', 'application/json')
        if (init.body != null) headers.set('Content-Type', 'application/json')
        if (runtimeConfig.apiKey) headers.set('Authorization', `Bearer ${runtimeConfig.apiKey}`)
        const response = await fetchImpl(new URL(path, `${runtimeConfig.baseUrl}/`), {
          ...init,
          headers,
          signal: controller.signal,
          redirect: 'error',
        })
        const text = await response.text()
        if (text.length > API_RESPONSE_MAX_CHARS) {
          throw new Error(`Vibe-Trading response exceeds ${API_RESPONSE_MAX_CHARS} characters`)
        }
        if (!response.ok) {
          throw new Error(`Vibe-Trading HTTP ${response.status}: ${clip(text, ERROR_PREVIEW_CHARS)}`)
        }
        if (!text) return {} as T
        return JSON.parse(text) as T
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Vibe-Trading request timed out after ${runtimeConfig.requestTimeoutMs}ms`)
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function loadAttemptView(
  client: ReturnType<typeof createVibeClient>,
  sessionId: string,
  requestedAttemptId: string | undefined,
  resultMaxChars: number,
): Promise<AttemptView> {
  const session = await client.request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`)
  const attemptId = requestedAttemptId ?? session.last_attempt_id ?? null
  const messages = await client.request<SessionMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=1000`)
  const assistant = [...messages].reverse().find((message) => (
    message.role === 'assistant'
    && (!attemptId || message.linked_attempt_id === attemptId)
  ))
  if (!assistant) return { sessionId, attemptId, status: 'running' }

  const rawStatus = assistant.metadata?.status
  const status = rawStatus === 'completed' ? 'completed' : 'failed'
  const clipped = clipWithFlag(assistant.content, resultMaxChars)
  return {
    sessionId,
    attemptId: assistant.linked_attempt_id ?? attemptId,
    status,
    result: clipped.value,
    truncated: clipped.truncated,
    ...(assistant.metadata?.run_id ? { runId: assistant.metadata.run_id } : {}),
    ...(assistant.metadata?.metrics !== undefined ? { metrics: toJsonValue(assistant.metadata.metrics) } : {}),
  }
}

async function monitorAttempt(input: {
  client: ReturnType<typeof createVibeClient>
  runtimeConfig: VibeTradingConfig
  taskRegistry: BackgroundTaskRegistry
  taskId: string
  sessionId: string
  attemptId: string
  description: string
  ctx: ToolContext
  sleep: (ms: number) => Promise<void>
  clockMs: () => number
}): Promise<void> {
  const startedAt = input.clockMs()
  try {
    while (input.clockMs() - startedAt < input.runtimeConfig.taskTimeoutMs) {
      const view = await loadAttemptView(
        input.client,
        input.sessionId,
        input.attemptId,
        input.runtimeConfig.resultMaxChars,
      )
      if (view.status === 'running') {
        await input.sleep(input.runtimeConfig.pollIntervalMs)
        continue
      }
      if (view.status === 'failed') {
        throw new Error(view.result || 'Vibe-Trading attempt failed')
      }

      const summary = `Vibe-Trading 研究已完成 (session=${input.sessionId}, attempt=${input.attemptId})`
      input.taskRegistry.complete(input.taskId, {
        summary,
        data: {
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          result: view.result ?? '',
          truncated: view.truncated ?? false,
          ...(view.runId ? { runId: view.runId } : {}),
          ...(view.metrics !== undefined ? { metrics: view.metrics } : {}),
        },
      })
      input.ctx.eventQueue.enqueue({
        type: 'background_task_completed',
        taskId: input.taskId,
        toolName: 'trading_agent',
        description: input.description,
        elapsedMs: input.clockMs() - startedAt,
        ok: true,
        summary,
      })
      return
    }
    throw new Error(`Vibe-Trading task timed out after ${input.runtimeConfig.taskTimeoutMs}ms`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ taskId: input.taskId, sessionId: input.sessionId, attemptId: input.attemptId, error: message }, 'trading_agent_failed')
    input.taskRegistry.fail(input.taskId, message)
    input.ctx.eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: input.taskId,
      toolName: 'trading_agent',
      description: input.description,
      elapsedMs: input.clockMs() - startedAt,
      ok: false,
      summary: clip(message, 500),
    })
  }
}

function boundedResearchPrompt(prompt: string): string {
  return [
    '[委派边界]',
    '只做金融研究、策略构思、历史回测或模拟分析。不得执行真实下单、撤单、券商授权、资金划转、定时任务或对外发送消息。',
    '如任务隐含真实交易动作，改为给出研究结论、模拟方案和风险条件。',
    '',
    '[研究任务]',
    prompt,
  ].join('\n')
}

function buildSessionTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return `qq-bot: ${clip(normalized, 80)}`
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Vibe-Trading response missing ${field}`)
  }
  return value
}

function clip(value: string, maxChars: number): string {
  return clipWithFlag(value, maxChars).value
}

function clipWithFlag(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: `${value.slice(0, Math.max(0, maxChars - 3))}...`, truncated: true }
}

function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return null
  }
}
