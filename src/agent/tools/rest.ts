import { z } from 'zod'
import { createLogger } from '../../logger.js'
import type { BotEvent } from '../event.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const DEFAULT_REST_DURATION_SECONDS = 60
export const MIN_REST_DURATION_SECONDS = 30
export const MAX_REST_DURATION_SECONDS = 1_800
export const REST_IMMEDIATE_DIRECTION_COUNT = 6

const directionSchema = z.string().trim().min(1).max(200)
const passiveExternalMessageDirection = /^(?:(?:继续)?(?:等|等待)|(?:看|查看|检查|留意|刷新|刷).*(?:回复|回信|新消息|群消息|私聊|有没有回|回没回))/

export const restIntentionSchema = z.object({
  preferredIndex: z.number().int().min(0).max(REST_IMMEDIATE_DIRECTION_COUNT - 1)
    .describe('醒来后默认先执行的 immediateDirections 下标, 从 0 开始; 只能选择无需外部事件即可开始的方向.'),
  immediateDirections: z.array(directionSchema)
    .length(REST_IMMEDIATE_DIRECTION_COUNT)
    .describe('恰好 6 个现在就能开始且不依赖未来外部输入的具体方向; 每个都写明对象和第一步动作. 等人、等消息、查看尚未到来的回复或轮询群聊都不是行动方向; 消息到来会由 runtime 另行唤醒.'),
}).superRefine((value, ctx) => {
  if (new Set(value.immediateDirections).size !== value.immediateDirections.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['immediateDirections'],
      message: 'immediateDirections 不能重复',
    })
  }
  for (const [index, direction] of value.immediateDirections.entries()) {
    if (!passiveExternalMessageDirection.test(direction)) continue
    ctx.addIssue({
      code: 'custom',
      path: ['immediateDirections', index],
      message: '等待或轮询外部消息不是行动方向; 消息到来会另行唤醒, 此处请写同时可以推进的自己的事',
    })
  }
})

export type RestIntention = z.infer<typeof restIntentionSchema>

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
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的休息秒数, 默认 60, 通常 30..120 已足够; 仅明确需要较长离开时才延长, 范围 30..1800.'),
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
  const preferredDirection = intention.immediateDirections[intention.preferredIndex]!
  return {
    content: JSON.stringify({
      ok: true,
      status,
      durationSeconds,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      restReason: reason,
      resumePlan: {
        preferredIndex: intention.preferredIndex,
        preferredDirection,
        immediateDirections: intention.immediateDirections,
        instruction: `现在先实际执行 immediateDirections[${intention.preferredIndex}]: ${preferredDirection}; 外部消息可能随时到来并切换注意力, 与此同时照常推进自己的事. 可以按新情况改选其他 immediateDirections, 但没有实际尝试前不要再次休息.`,
      },
    }),
    outcome: { ok: true, code: status },
    effects: [{ type: 'pause' }],
  }
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer

  return {
    name: 'rest',
    description: [
      '一段活动确实告一段落时主动安排短暂休息, 默认 1 分钟; 通常选择 30 到 120 秒已足够, 最长 30 分钟仅用于明确需要较长离开的情况。',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由。',
      'intention 必填且结构化: immediateDirections 必须恰好列 6 个现在无需等待任何人就能开始的具体方向, 每个写明对象和第一步动作; preferredIndex 从中选一个醒来后默认先执行。',
      '外部消息不是行动方向, 也不与做自己的事冲突: 不要列等人、等消息、查看尚未到来的回复或轮询群聊; 消息到来时 runtime 会另行唤醒并让你切换注意力, 在此之前照常推进自己的事。',
      '一个任务做完只是注意力重新自由, 不是“今天全部完成”; intention 不要回顾已完成清单或把事情推到明天, 要留下醒来后真能开始的新方向。',
      '醒来后先执行 preferredIndex 指向的方向; 没有实际尝试前不要立刻再次休息。方向不是硬计划, 可按现场情况选择一个、合并几个或改道。',
      '不要用“继续看”“随便逛逛”这类没有对象和动作的句子充当方向。',
      '休息期间普通群消息不会打断; 被 @、私聊、后台任务完成或停止信号会立刻唤醒。',
      '事件只用于唤醒, 不会被这个工具消费; 下一轮会正常进入上下文。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const durationSeconds = args.durationSeconds ?? DEFAULT_REST_DURATION_SECONDS
      const durationMs = durationSeconds * 1000
      let timerHandle: unknown = null
      let elapsed = false
      const attentionAbort = new AbortController()

      log.info({
        durationSeconds,
        reason: args.reason,
        preferredIndex: args.intention.preferredIndex,
        preferredDirection: args.intention.immediateDirections[args.intention.preferredIndex],
        immediateDirections: args.intention.immediateDirections,
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

export const restTool = createRestTool()
