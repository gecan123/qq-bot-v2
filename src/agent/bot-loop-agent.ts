import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { maybeCompactConversation, type MaybeCompactOptions } from './compaction.js'
import { injectStickerPoolAfterCompaction } from './sticker-pool.js'
import { runReactRound } from './react-kernel.js'
import { interpretToolEffects } from './effect-interpreter.js'
import { createLogger } from '../logger.js'
import {
  planMailboxDisclosures,
  renderMailboxNotification,
  type MailboxCursors,
} from './mailbox.js'

const log = createLogger('BOT_LOOP')

export interface BotLoopAgentDeps {
  systemPrompt: string
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  tools: ToolExecutor
  snapshotRepo: BotSnapshotRepo
  /** 从持久 snapshot 同行恢复的 per-source 披露游标。 */
  initialMailboxCursors?: Readonly<MailboxCursors>
  /** 新来源在尚无 cursor 时使用的旧式恢复边界。 */
  initialLastWakeAt?: Date | null
  /**
   * 把 BotEvent 翻译成 user-role AgentMessage 的纯函数。
   * 字节稳定 = cache 命中前提:同样的 messageRowId 渲染必须每次输出同样字节。
   */
  renderEvent: (event: BotEvent) => Promise<string | null> | string | null
  /** 测试可注入。 */
  compactOptions?: MaybeCompactOptions
  /** 单 round 失败后退避时间。 */
  errorBackoffMs?: number
  /** 队列有事件时，drain 前等待更多事件堆积的毫秒数（0 = 不等）。 */
  eventDebounceMs?: number
  /** 测试可注入。等待外部事件期间用于保活进程；不产生 wake 或 tool result。 */
  keepAlive?: {
    open: () => { close: () => void }
  }
  /** 运行时自主循环保护；不进入 AgentContext 或 snapshot。 */
  autonomy?: BotLoopAutonomyOptions
  /** 可选的 Life Journal 自省 hook；输出不进入 AgentContext。 */
  lifeJournal?: BotLoopLifeJournal
}

export interface BotLoopLifeJournal {
  recordRound(input: { roundIndex: number; messages: AgentMessage[] }): Promise<unknown>
  pickIdleIntention?(): Promise<{ ok: boolean; intention: string | null }>
}

export interface BotLoopAutonomyOptions {
  maxConsecutiveRounds?: number
  cooldownMs?: number
  dailyTokenBudget?: number
  now?: () => Date
  waitForAttentionOrTimeout?: (
    queue: EventQueue<BotEvent>,
    timeoutMs: number,
  ) => Promise<'attention' | 'elapsed'>
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000
const DEFAULT_EVENT_DEBOUNCE_MS = 3_000
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 86_400_000
const DEFAULT_MAX_CONSECUTIVE_ROUNDS = 20
const DEFAULT_AUTONOMY_COOLDOWN_MS = 60_000
const DEFAULT_DAILY_TOKEN_BUDGET = 200_000
const defaultKeepAlive = {
  open() {
    const timer = setInterval(() => {}, DEFAULT_KEEP_ALIVE_INTERVAL_MS)
    return {
      close() {
        clearInterval(timer)
      },
    }
  },
}

export interface BotLoopAgent {
  start(): Promise<void>
  stop(): Promise<void>
  /** 测试用:跑一次 runOnce 不进入 while 循环。 */
  runOnceForTest(): Promise<void>
}

export function createBotLoopAgent(deps: BotLoopAgentDeps): BotLoopAgent {
  const autonomy = {
    maxConsecutiveRounds: Math.max(1, deps.autonomy?.maxConsecutiveRounds ?? DEFAULT_MAX_CONSECUTIVE_ROUNDS),
    cooldownMs: Math.max(1, deps.autonomy?.cooldownMs ?? DEFAULT_AUTONOMY_COOLDOWN_MS),
    dailyTokenBudget: Math.max(1, deps.autonomy?.dailyTokenBudget ?? DEFAULT_DAILY_TOKEN_BUDGET),
    now: deps.autonomy?.now ?? (() => new Date()),
    waitForAttentionOrTimeout: deps.autonomy?.waitForAttentionOrTimeout ?? waitForAttentionOrTimeout,
  }
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  let roundIndex = 0
  let consecutiveRounds = 0
  let budgetAttentionAllowance = 0
  let budgetDay = beijingDayKey(autonomy.now())
  let dailyTokens = 0

  async function drainEvents(): Promise<{ consumed: number; disclosed: number; hadAttention: boolean }> {
    const events: BotEvent[] = []
    let disclosed = 0
    while (true) {
      const event = deps.eventQueue.dequeue()
      if (!event) break
      events.push(event)
    }

    const plan = planMailboxDisclosures(events, mailboxCursors)
    mailboxCursors = plan.cursors
    for (const disclosure of plan.disclosures) {
      if (disclosure.kind === 'mailbox') {
        deps.context.appendUserMessage(
          renderMailboxNotification(disclosure.mailboxKey, disclosure.events),
        )
        disclosed++
        lastWakeAt = new Date()
        continue
      }

      if (disclosure.event.type === 'wake') continue
      const rendered = await deps.renderEvent(disclosure.event)
      if (rendered == null || rendered.length === 0) continue
      deps.context.appendUserMessage(rendered)
      disclosed++
      if (
        disclosure.event.type === 'napcat_message' ||
        disclosure.event.type === 'napcat_private_message'
      ) {
        lastWakeAt = new Date()
      }
    }
    return {
      consumed: events.length,
      disclosed,
      hadAttention: events.some(isAttentionEvent),
    }
  }

  async function runRound(): Promise<{
    inputTokens: number | null
    tokensUsed: number
    didPause: boolean
  }> {
    roundIndex++
    const result = await runReactRound({
      systemPrompt: deps.systemPrompt,
      context: deps.context,
      llm: deps.llm,
      tools: deps.tools,
      toolContext: {
        eventQueue: deps.eventQueue,
        roundIndex,
      },
    })
    const { didPause } = interpretToolEffects(result.effects)

    return {
      inputTokens: result.inputTokens,
      tokensUsed: result.tokensUsed,
      didPause,
    }
  }

  async function maybeCompact(inputTokens: number | null): Promise<void> {
    let compacted = false
    try {
      const before = deps.context.getSnapshot().messages.length
      await maybeCompactConversation(deps.context, inputTokens, deps.compactOptions)
      compacted = deps.context.getSnapshot().messages.length < before
    } catch (err) {
      log.error({ err }, 'compaction_failed_skipped')
    }
    if (compacted) {
      try {
        await injectStickerPoolAfterCompaction(deps.context)
      } catch (err) {
        log.warn({ err }, 'sticker_pool_injection_failed')
      }
    }
  }

  async function step(): Promise<{
    ranRound: boolean
    tokensUsed?: number
    didPause?: boolean
    hadAttention?: boolean
  }> {
    const beforeStepCount = deps.context.getSnapshot().messages.length
    const debounceMs = deps.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS
    if (deps.eventQueue.size() > 0 && debounceMs > 0 && !stopRequested) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelDebounceSleep = null
          resolve()
        }, debounceMs)
        cancelDebounceSleep = () => {
          clearTimeout(timer)
          cancelDebounceSleep = null
          resolve()
        }
      })
    }
    const { consumed, disclosed, hadAttention } = await drainEvents()
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: consumed, eventsDisclosed: disclosed }, 'round_start')

    if (consumed > 0 && disclosed === 0) {
      return { ranRound: false }
    }

    if (deps.context.getSnapshot().messages.length === 0) {
      return { ranRound: false }
    }

    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      mailboxCursors,
      lastWakeAt,
    })

    const { inputTokens, tokensUsed, didPause } = await runRound()
    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      mailboxCursors,
      lastWakeAt,
    })
    try {
      const roundMessages = deps.context.getSnapshot().messages.slice(beforeStepCount)
      await deps.lifeJournal?.recordRound({ roundIndex, messages: roundMessages })
    } catch (err) {
      log.warn({ err, roundIndex }, 'life_journal_record_failed_skipped')
    }
    await maybeCompact(inputTokens)
    return { ranRound: true, tokensUsed, didPause, hadAttention }
  }

  async function runOnce(): Promise<void> {
    const { ranRound, tokensUsed = 0, didPause = false, hadAttention = false } = await step()
    if (!ranRound && !stopRequested) {
      await waitForExternalEvent()
      return
    }
    if (!ranRound || stopRequested) return

    resetDailyBudgetIfNeeded()
    dailyTokens += tokensUsed
    if (hadAttention) budgetAttentionAllowance = autonomy.maxConsecutiveRounds
    if (budgetAttentionAllowance > 0) budgetAttentionAllowance--

    if (didPause) {
      consecutiveRounds = 0
      budgetAttentionAllowance = Math.max(budgetAttentionAllowance, 1)
      return
    }

    consecutiveRounds++
    if (consecutiveRounds >= autonomy.maxConsecutiveRounds) {
      log.info({ consecutiveRounds, cooldownMs: autonomy.cooldownMs }, 'autonomy_round_cooldown_enter')
      const result = await autonomy.waitForAttentionOrTimeout(deps.eventQueue, autonomy.cooldownMs)
      consecutiveRounds = 0
      if (result === 'attention') budgetAttentionAllowance = autonomy.maxConsecutiveRounds
      return
    }

    if (dailyTokens >= autonomy.dailyTokenBudget && budgetAttentionAllowance <= 0) {
      const timeoutMs = millisecondsUntilNextBeijingDay(autonomy.now())
      log.info({ dailyTokens, budget: autonomy.dailyTokenBudget, timeoutMs }, 'autonomy_daily_budget_wait')
      const result = await autonomy.waitForAttentionOrTimeout(deps.eventQueue, timeoutMs)
      if (result === 'attention') {
        budgetAttentionAllowance = autonomy.maxConsecutiveRounds
      } else {
        resetDailyBudgetIfNeeded()
      }
    }
  }

  function resetDailyBudgetIfNeeded(): void {
    const nextDay = beijingDayKey(autonomy.now())
    if (nextDay === budgetDay) return
    budgetDay = nextDay
    dailyTokens = 0
    budgetAttentionAllowance = 0
  }

  async function waitForExternalEvent(): Promise<void> {
    const keepAlive = (deps.keepAlive ?? defaultKeepAlive).open()
    try {
      await deps.eventQueue.waitForEvent()
    } finally {
      keepAlive.close()
    }
  }

  async function loop(): Promise<void> {
    while (true) {
      if (stopRequested) break
      try {
        await runOnce()
      } catch (err) {
        log.error({ err, roundIndex }, 'round_failed_backing_off')
        await sleep(deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS)
      }
    }
  }

  return {
    async start() {
      stopRequested = false
      log.info('bot_loop_started')
      await loop()
    },
    async stop() {
      stopRequested = true
      cancelDebounceSleep?.()
      deps.eventQueue.enqueue({ type: 'wake' })
      log.info('bot_loop_stop_requested')
    },
    async runOnceForTest() {
      await step()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAttentionEvent(event: BotEvent): boolean {
  if (event.type === 'napcat_private_message') return true
  if (event.type === 'napcat_message') return event.mentionedSelf
  return event.type === 'background_task_completed' || event.type === 'wake'
}

async function waitForAttentionOrTimeout(
  queue: EventQueue<BotEvent>,
  timeoutMs: number,
): Promise<'attention' | 'elapsed'> {
  const attentionAbort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      queue
        .waitForEventWhere(isAttentionEvent, { signal: attentionAbort.signal })
        .then(() => 'attention' as const),
      new Promise<'elapsed'>((resolve) => {
        timer = setTimeout(() => resolve('elapsed'), timeoutMs)
      }),
    ])
  } finally {
    attentionAbort.abort()
    if (timer != null) clearTimeout(timer)
  }
}

function beijingDayKey(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function millisecondsUntilNextBeijingDay(date: Date): number {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const nextMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  )
  return Math.max(1, nextMidnightUtc - shifted.getTime())
}
