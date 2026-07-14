import { z } from 'zod'
import { createLogger } from '../../logger.js'
import type { AgentMessage, ToolResultContent } from '../agent-context.types.js'
import type { BotEvent } from '../event.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const DEFAULT_REST_DURATION_SECONDS = 60
export const MIN_REST_DURATION_SECONDS = 30
export const MAX_REST_DURATION_SECONDS = 600

const directionSchema = z.string().trim().min(1).max(200)
const passiveExternalMessageDirection = /^(?:(?:继续)?(?:等|等待)|(?:看|查看|检查|留意|刷新|刷).*(?:回复|回信|新消息|群消息|私聊|有没有回|回没回))/
const passiveMarketPollingDirection = /^(?:继续)?(?:检查|查看|观察|刷新|跟踪|盯|留意).*(?:价格|行情|走势|K\s*线|市场|仓位|状态|进度)/i
const mechanicalMaintenanceDirection = /^(?:继续)?(?:整理|更新|维护|检查|写).*(?:memory|记忆|journal|日记|agenda|待办)$/i
const vagueBrowsingDirection = /^(?:继续)?(?:浏览|刷|看|阅读|读)(?:一下)?\s*(?:HN|Hacker News|Reddit|新帖|热帖|技术文章|社区|资讯)$/i

export const restIntentionSchema = z.object({
  primaryDirection: directionSchema
    .describe('醒来后最想先做的一个具体方向; 写明对象和第一步动作, 且无需等待外部事件即可开始.'),
  alternativeDirection: directionSchema
    .describe('主方向不再有吸引力时可立即改做的一个不同方向; 同样写明对象和第一步动作.'),
}).superRefine((value, ctx) => {
  if (value.primaryDirection === value.alternativeDirection) {
    ctx.addIssue({
      code: 'custom',
      path: ['alternativeDirection'],
      message: 'alternativeDirection 必须和 primaryDirection 不同',
    })
  }
  for (const [field, direction] of Object.entries(value) as Array<[keyof typeof value, string]>) {
    const issue = invalidDirectionMessage(direction)
    if (issue) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: issue,
      })
    }
  }
})

export type RestIntention = z.infer<typeof restIntentionSchema>

export interface RestToolDeps {
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  pickAlternative?: () => Promise<RestAlternativePickResult>
  canConfirmAlternative?: () => boolean
}

export interface RestAlternative {
  thought: string
  direction: string
  anchorSource: 'recent_context' | 'agenda' | 'journal' | 'wishes'
  whyNow: string
  firstStep: string
  promoteToGoal: boolean
}

export type RestAlternativePickResult =
  | { status: 'available'; alternative: RestAlternative }
  | { status: 'none' }
  | { status: 'unavailable'; error: string }

const defaultTimer = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const argsSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的短休息秒数, 默认 60, 范围 30..600.'),
  confirmed: z.boolean().default(false)
    .describe('第一次请求必须为 false. 仅当前一次 pause 已返回 alternative_available、此后没有别的工具结果且你仍真想休息时, 再次调用并设为 true.'),
  reason: z.string().trim().min(1).max(300)
    .describe('这次确实想暂停当前活动的原因. 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.'),
  intention: restIntentionSchema,
})

type RestArgs = z.infer<typeof argsSchema>

function isAttentionEvent(event: BotEvent): boolean {
  if (event.type === 'napcat_private_message') return true
  if (event.type === 'napcat_message') return event.mentionedSelf
  if (event.type === 'background_task_completed') return true
  if (event.type === 'scheduled_wake') return true
  if (event.type === 'wake') return true
  return false
}

function restResult(
  status: 'elapsed' | 'interrupted',
  durationSeconds: number,
  elapsedMs: number,
  reason: string,
  intention: RestIntention,
): ToolExecutionResult {
  return {
    content: JSON.stringify({
      ok: true,
      status,
      durationSeconds,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      restReason: reason,
      resumePlan: {
        primaryDirection: intention.primaryDirection,
        alternativeDirection: intention.alternativeDirection,
        instruction: `醒来后重新评估: primaryDirection 仍有吸引力就执行第一步: ${intention.primaryDirection}; 若它已失效, 再看 alternativeDirection: ${intention.alternativeDirection}. 两者都失效且没有未处理义务时可以自然结束当前活动轮, 不要用写 Journal、发消息或再次休息表演收尾.`,
      },
    }),
    outcome: { ok: true, code: status },
    effects: [{ type: 'pause', status }],
  }
}

function alternativeCheckUnavailable(error: unknown): ToolExecutionResult {
  const message = (error instanceof Error ? error.message : String(error || 'idle alternative check failed'))
    .slice(0, 300)
  return {
    content: JSON.stringify({
      ok: false,
      status: 'alternative_check_unavailable',
      paused: false,
      error: message,
      instruction: '没有进入休息。空闲念头检查暂时不可用；不要用 confirmed=true 跳过检查，请稍后以 confirmed=false 重试或继续当前活动.',
    }),
    outcome: { ok: false, code: 'alternative_check_unavailable', error: message },
  }
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer
  const alternativeOfferedRounds = new Set<number>()

  return {
    name: 'rest',
    description: [
      '确实想暂时停一下时安排短休息, 默认 1 分钟, 最长 10 分钟; 它是安全阀, 不是“暂时没事做”的默认动作。',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由。',
      '第一次调用 confirmed 必须为 false; runtime 会先从最近真实上下文寻找锚点, 再以 Agenda、近期 Life Journal 或愿望作后备。若长出一个真实念头, 会返回 alternative_available 而不暂停。',
      '若首次检查超时、provider 失败或结果不完整, 会返回 alternative_check_unavailable 且不暂停; 只能稍后以 confirmed=false 重试或继续当前活动, 不能用 confirmed=true 跳过检查。',
      'alternative_available 里的 idleThought 是你自己的念头, 不是任务或命令: 可以顺着 firstStep 做一点; 看过后仍真想休息, 才再次调用并设 confirmed=true。',
      'intention 只保留一个 primaryDirection 和一个不同的 alternativeDirection, 都要写明具体对象和第一步动作。不要为了填菜单制造六个占位方向。',
      '等人、等消息、轮询群聊、机械检查行情、泛泛浏览 HN/Reddit、整理 memory/journal 都不是休息后的真实方向。价格或行情需要未来某个时点再看时用 schedule, 不要靠反复休息轮询。',
      '一个任务做完后重新评估: 有真实后续就继续, 没有未处理义务或牵引力就结束当前活动轮; 不要为证明自主而制造方向。',
      '休息期间普通群消息不会打断; 被 @、私聊、后台任务完成或停止信号会立刻唤醒。',
      '事件只用于唤醒, 不会被这个工具消费; 下一轮会正常进入上下文。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      for (const roundIndex of alternativeOfferedRounds) {
        if (roundIndex < ctx.roundIndex - 1) alternativeOfferedRounds.delete(roundIndex)
      }
      const hasRecentAlternative = deps.canConfirmAlternative?.()
        ?? (
          alternativeOfferedRounds.has(ctx.roundIndex)
          || alternativeOfferedRounds.has(ctx.roundIndex - 1)
        )
      if (args.confirmed && deps.pickAlternative && !hasRecentAlternative) {
        log.info({ reason: args.reason, roundIndex: ctx.roundIndex }, 'rest_confirmation_rejected')
        return {
          content: JSON.stringify({
            ok: true,
            status: 'confirmation_required',
            paused: false,
            instruction: '没有进入休息。confirmed 不能用于跳过第一次检查; 请先以 confirmed=false 调用并查看是否返回 alternative_available.',
          }),
          outcome: { ok: true, code: 'confirmation_required' },
        }
      }
      if (!args.confirmed && deps.pickAlternative) {
        let picked: RestAlternativePickResult
        try {
          picked = await deps.pickAlternative()
        } catch (error) {
          log.warn({ err: error }, 'rest_alternative_pick_failed')
          return alternativeCheckUnavailable(error)
        }
        if (picked.status === 'unavailable') {
          log.warn({
            error: picked.error,
            reason: args.reason,
            roundIndex: ctx.roundIndex,
          }, 'rest_alternative_pick_unavailable')
          return alternativeCheckUnavailable(picked.error)
        }
        if (picked.status === 'available') {
          const alternative = picked.alternative
          alternativeOfferedRounds.add(ctx.roundIndex)
          log.info({
            reason: args.reason,
            direction: alternative.direction,
            anchorSource: alternative.anchorSource,
            promoteToGoal: alternative.promoteToGoal,
          }, 'rest_redirected')
          return {
            content: JSON.stringify({
              ok: true,
              status: 'alternative_available',
              paused: false,
              idleThought: {
                event: 'idle_thought',
                ...alternative,
              },
              instruction: alternative.promoteToGoal
                ? '没有进入休息。idleThought 是你自己的念头而不是任务；若它确实有吸引力且值得跨多轮推进, 用 goal action=create_self 建立持久主线并完成 firstStep。若让它过去后仍真想休息, 再次调用 pause 并设 confirmed=true.'
                : '没有进入休息。idleThought 是你自己的念头而不是任务；有吸引力就先完成 firstStep，也可以让它过去。若看过后仍真想休息, 再次调用 pause 并设 confirmed=true.',
            }),
            outcome: { ok: true, code: 'alternative_available' },
          }
        }
      }

      if (args.confirmed) {
        alternativeOfferedRounds.delete(ctx.roundIndex)
        alternativeOfferedRounds.delete(ctx.roundIndex - 1)
      }

      const durationSeconds = args.durationSeconds ?? DEFAULT_REST_DURATION_SECONDS
      const durationMs = durationSeconds * 1000
      let timerHandle: unknown = null
      let elapsed = false
      const attentionAbort = new AbortController()

      log.info({
        durationSeconds,
        reason: args.reason,
        confirmed: args.confirmed,
        primaryDirection: args.intention.primaryDirection,
        alternativeDirection: args.intention.alternativeDirection,
      }, 'rest_enter')
      const startedAt = Date.now()

      const timeoutPromise = new Promise<'elapsed'>((resolve) => {
        timerHandle = timer.setTimeout(() => {
          elapsed = true
          resolve('elapsed')
        }, durationMs)
      })

      try {
        const result = await Promise.race([
          ctx.eventQueue
            .waitForEventWhere(isAttentionEvent, { signal: attentionAbort.signal })
            .then(() => 'interrupted' as const),
          timeoutPromise,
        ])
        const elapsedMs = Date.now() - startedAt

        if (result === 'interrupted') {
          log.info({ elapsedMs }, 'rest_interrupted')
          return restResult('interrupted', durationSeconds, elapsedMs, args.reason, args.intention)
        }

        log.info({ elapsedMs }, 'rest_elapsed')
        return restResult('elapsed', durationSeconds, elapsedMs, args.reason, args.intention)
      } finally {
        attentionAbort.abort()
        if (!elapsed && timerHandle != null) {
          timer.clearTimeout(timerHandle)
        }
      }
    },
  }
}

export function hasPendingRestAlternative(messages: readonly AgentMessage[]): boolean {
  for (let toolIndex = messages.length - 1; toolIndex >= 0; toolIndex--) {
    const toolMessage = messages[toolIndex]
    if (toolMessage?.role !== 'tool') continue
    if (!isAlternativeAvailableResult(toolMessage.content)) return false

    for (let callIndex = toolIndex - 1; callIndex >= 0; callIndex--) {
      const assistantMessage = messages[callIndex]
      if (assistantMessage?.role !== 'assistant') continue
      const matchingCall = assistantMessage.toolCalls.find((call) => call.id === toolMessage.toolCallId)
      return matchingCall != null && (matchingCall.name === 'pause' || matchingCall.name === 'rest')
    }
    return false
  }
  return false
}

function isAlternativeAvailableResult(content: ToolResultContent): boolean {
  if (typeof content !== 'string') return false
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const result = parsed as Record<string, unknown>
    return result.status === 'alternative_available' && result.paused === false
  } catch {
    return false
  }
}

function invalidDirectionMessage(direction: string): string | null {
  if (passiveExternalMessageDirection.test(direction)) {
    return '等待或轮询外部消息不是行动方向; 消息到来会另行唤醒, 此处请写同时可以推进的自己的事'
  }
  if (passiveMarketPollingDirection.test(direction)) {
    return '机械检查行情、价格或进度不是行动方向; 需要未来再看时请用 schedule, 此处写一个能产生新认识或作品的具体动作'
  }
  if (mechanicalMaintenanceDirection.test(direction)) {
    return '机械整理 memory、journal、Agenda 或待办不是行动方向; 只有真实经历或状态变化时才更新它们'
  }
  if (vagueBrowsingDirection.test(direction)) {
    return '泛泛浏览站点或资讯不是具体方向; 请写明要看的对象、问题和第一步'
  }
  return null
}

export const restTool = createRestTool()
