import { z } from 'zod'
import type { Tool, ToolExecutionResult } from '../tool.js'
import { createLogger } from '../../logger.js'
import { isAttentionEvent } from '../notification.js'

const log = createLogger('TOOL_PAUSE')
export const DEFAULT_REST_DURATION_SECONDS = 60
export const MIN_REST_DURATION_SECONDS = 30
export const MAX_REST_DURATION_SECONDS = 600

const directionSchema = z.string().trim().min(1).max(200)
const passiveExternalMessageDirection = /^(?:(?:继续)?(?:等|等待)|(?:看|查看|检查|留意|刷新|刷).*(?:回复|回信|新消息|群消息|私聊|有没有回|回没回))/
const passiveMarketPollingDirection = /^(?:继续)?(?:检查|查看|观察|刷新|跟踪|盯|留意).*(?:价格|行情|走势|K\s*线|市场|仓位|状态|进度)/i
const mechanicalMaintenanceDirection = /^(?:继续)?(?:整理|更新|维护|检查|写).*(?:memory|记忆|journal|日记|agenda|待办)$/i
const vagueBrowsingDirection = /^(?:继续)?(?:浏览|刷|看|阅读|读)(?:一下)?\s*(?:HN|Hacker News|Reddit|新帖|热帖|技术文章|社区|资讯)$/i

export const restIntentionSchema = z.object({
  primaryDirection: directionSchema,
  alternativeDirection: directionSchema,
}).superRefine((value, ctx) => {
  if (value.primaryDirection === value.alternativeDirection) {
    ctx.addIssue({ code: 'custom', path: ['alternativeDirection'], message: 'alternativeDirection 必须和 primaryDirection 不同' })
  }
  for (const [field, direction] of Object.entries(value) as Array<[keyof typeof value, string]>) {
    const issue = invalidDirectionMessage(direction)
    if (issue) ctx.addIssue({ code: 'custom', path: [field], message: issue })
  }
})

type RestIntention = z.infer<typeof restIntentionSchema>

export interface RestToolDeps {
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const defaultTimer = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const argsSchema = z.object({
  action: z.literal('rest').describe('主动短暂休息, 普通群消息不打断.'),
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的短休息秒数, 默认 60, 范围 30..600.'),
  reason: z.string().trim().min(1).max(300)
    .describe('这次确实想暂停当前活动的原因. 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.'),
  intention: restIntentionSchema,
})

type Args = z.infer<typeof argsSchema>

export interface PauseToolDeps {
  rest?: RestToolDeps
}

export function createPauseTool(deps: PauseToolDeps = {}): Tool<Args> {
  const timer = deps.rest?.timer ?? defaultTimer

  return {
    name: 'pause',
    description: [
      '对话节奏控制工具.',
      'action=rest: 确实想暂时停一下时短休息; 默认 1 分钟, 最长 10 分钟. 它是安全阀, 不是空闲默认动作.',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.',
      '没有未处理义务或真实牵引力时直接结束当前活动轮, runtime 会自然等待; 不要为了收尾调用 pause.',
      '调用 pause 表示此刻确实选择短暂休息, 会立即进入计时, 不再同步请求额外的 LLM 判断.',
      'intention 只写一个具体 primaryDirection 和一个不同的 alternativeDirection, 都必须写明对象和第一步; 不要制造六项菜单.',
      '等消息、轮询群聊、机械盯行情、泛泛浏览站点或整理 memory/journal 都不是行动方向; 未来时点再看行情用 schedule.',
      '一个任务做完后重新评估: 有真实后续就继续, 没有未处理义务或牵引力就结束当前活动轮; 不要用发消息、写 Journal 或再次休息表演收尾.',
      '如果当前精力允许且 primaryDirection 可以立即执行, 就现在直接执行; reason 要说明为什么此刻休息比立即行动更合适.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx): Promise<ToolExecutionResult> {
      const args = argsSchema.parse(rawArgs)
      const durationMs = args.durationSeconds * 1000
      let timerHandle: unknown = null
      let elapsed = false
      const attentionAbort = new AbortController()
      const startedAt = Date.now()
      log.info({ durationSeconds: args.durationSeconds, reason: args.reason }, 'pause_enter')
      const timeoutPromise = new Promise<'elapsed'>((resolve) => {
        timerHandle = timer.setTimeout(() => {
          elapsed = true
          resolve('elapsed')
        }, durationMs)
      })
      try {
        const status = await Promise.race([
          ctx.eventQueue.waitForEventWhere(isAttentionEvent, { signal: attentionAbort.signal })
            .then(() => 'interrupted' as const),
          timeoutPromise,
        ])
        return restResult(status, args.durationSeconds, Date.now() - startedAt, args.reason, args.intention)
      } finally {
        attentionAbort.abort()
        if (!elapsed && timerHandle != null) timer.clearTimeout(timerHandle)
      }
    },
  }
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
    outcome: { ok: true, code: status, progress: false, continuation: 'wait_attention' },
    effects: [{ type: 'pause', status }],
  }
}

function invalidDirectionMessage(direction: string): string | null {
  if (passiveExternalMessageDirection.test(direction)) return '等待或轮询外部消息不是行动方向; 消息到来会另行唤醒'
  if (passiveMarketPollingDirection.test(direction)) return '机械检查行情、价格或进度不是行动方向; 需要未来再看时请用 schedule'
  if (mechanicalMaintenanceDirection.test(direction)) return '机械整理 memory、journal、Agenda 或待办不是行动方向'
  if (vagueBrowsingDirection.test(direction)) return '泛泛浏览站点或资讯不是具体方向; 请写明对象、问题和第一步'
  return null
}

export const pauseTool = createPauseTool()
