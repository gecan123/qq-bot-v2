import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { isLlmContextOverflowError, isLlmUsageLimitError, type LlmClient } from './llm-client.js'
import type { MessageSentTarget, ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import {
  compactConversationForRecovery,
  maybeCompactConversation,
  type MaybeCompactOptions,
} from './compaction.js'
import { injectStickerPoolAfterCompaction } from './sticker-pool.js'
import { LlmOutputTruncatedError, runReactRound } from './react-kernel.js'
import { interpretToolEffects } from './effect-interpreter.js'
import {
  renderInterruptedRestAttentionReminder,
  renderRestResumeReminder,
  shouldAppendInterruptedRestAttentionReminder,
  shouldAppendRestResumeReminder,
} from './rest-resume-reminder.js'
import { createLogger } from '../logger.js'
import {
  isHighPriorityMailboxDisclosure,
  planMailboxDisclosures,
  renderMailboxBacklogNotification,
  renderMailboxNotification,
  type MailboxDisclosure,
  type MailboxCursors,
} from './mailbox.js'
import type { AgentGoal, GoalStore } from './goal-store.js'
import { renderGoalContinuation, renderGoalStateEvent } from './goal-render.js'
import {
  decideMailboxCompensation,
  parseMailboxContinuityState,
  recordMailboxCompaction,
  recordMailboxDisclosure,
  recordMailboxRound,
  type MailboxContinuityState,
} from './mailbox-continuity.js'
import {
  findPendingMailboxThroughRowId,
  renderMailboxHandledEvent,
} from './mailbox-handled.js'

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
  /** 与 snapshot 同行恢复的 per-source 上下文新鲜度状态。 */
  initialMailboxContinuity?: MailboxContinuityState
  /** 新来源在尚无 cursor 时使用的旧式恢复边界。 */
  initialLastWakeAt?: Date | null
  /** 与 snapshot 同行恢复的 goal control revision；只控制 LLM 可见状态事件的去重。 */
  initialGoalRevision?: number
  /** 单一持久 goal 控制面；不存在时保持旧自主循环行为。 */
  goalStore?: GoalStore
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
  pickIdleIntention?(input?: { recentMessages?: readonly AgentMessage[] }): Promise<{
    ok: boolean
    thought: string | null
    intention: string | null
    anchorSource?: 'recent_context' | 'agenda' | 'journal' | 'wishes' | null
    whyNow?: string | null
    firstStep?: string | null
    promoteToGoal?: boolean
  }>
}

export interface BotLoopAutonomyOptions {
  maxConsecutiveRounds?: number
  cooldownMs?: number
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
const MAX_OUTPUT_CONTINUATIONS_PER_ROUND = 2
const OUTPUT_CONTINUATION_PROMPT =
  '[runtime recovery] 上一段 assistant 输出达到长度上限。请从中断处继续，不要重复已完成内容，并用一个完整的工具调用结束本轮。'
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
  flush(): Promise<void>
  /** 测试用:跑一次 runOnce 不进入 while 循环。 */
  runOnceForTest(): Promise<void>
}

export function createBotLoopAgent(deps: BotLoopAgentDeps): BotLoopAgent {
  const autonomy = {
    maxConsecutiveRounds: Math.max(1, deps.autonomy?.maxConsecutiveRounds ?? DEFAULT_MAX_CONSECUTIVE_ROUNDS),
    cooldownMs: Math.max(1, deps.autonomy?.cooldownMs ?? DEFAULT_AUTONOMY_COOLDOWN_MS),
    now: deps.autonomy?.now ?? (() => new Date()),
    waitForAttentionOrTimeout: deps.autonomy?.waitForAttentionOrTimeout ?? waitForAttentionOrTimeout,
  }
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  const mailboxContinuity = parseMailboxContinuityState(deps.initialMailboxContinuity)
  let goalRevision = Math.max(0, deps.initialGoalRevision ?? 0)
  let roundIndex = 0
  let consecutiveRounds = 0

  function drainEvents(): {
    consumed: number
    hadAttention: boolean
    beforeGoal: MailboxDisclosure[]
    afterGoal: MailboxDisclosure[]
  } {
    const events: BotEvent[] = []
    while (true) {
      const event = deps.eventQueue.dequeue()
      if (!event) break
      events.push(event)
    }

    const plan = planMailboxDisclosures(events, mailboxCursors)
    mailboxCursors = plan.cursors
    const highPriorityDisclosures: MailboxDisclosure[] = []
    const scheduledWakeDisclosures: MailboxDisclosure[] = []
    const ordinaryDisclosures: MailboxDisclosure[] = []
    for (const disclosure of plan.disclosures) {
      if (isHighPriorityMailboxDisclosure(disclosure)) {
        highPriorityDisclosures.push(disclosure)
      } else if (
        disclosure.kind === 'direct' &&
        disclosure.event.type === 'scheduled_wake'
      ) {
        scheduledWakeDisclosures.push(disclosure)
      } else {
        ordinaryDisclosures.push(disclosure)
      }
    }
    return {
      consumed: events.length,
      hadAttention: events.some(isAttentionEvent),
      beforeGoal: [...highPriorityDisclosures, ...scheduledWakeDisclosures],
      afterGoal: ordinaryDisclosures,
    }
  }

  async function discloseEvents(disclosures: readonly MailboxDisclosure[]): Promise<number> {
    let disclosed = 0
    for (const disclosure of disclosures) {
      if (disclosure.kind === 'backlog') {
        deps.context.appendUserMessage(renderMailboxBacklogNotification(disclosure.event))
        recordMailboxDisclosure(
          mailboxContinuity,
          disclosure.event.mailboxKey,
          disclosure.event.timeRange.to.getTime(),
        )
        disclosed++
        lastWakeAt = new Date()
        continue
      }

      if (disclosure.kind === 'mailbox') {
        const latestMessageAtMs = disclosure.events.at(-1)!.sentAt.getTime()
        const compensation = decideMailboxCompensation(
          mailboxContinuity,
          disclosure.mailboxKey,
          latestMessageAtMs,
        )
        deps.context.appendUserMessage(
          renderMailboxNotification(disclosure.mailboxKey, disclosure.events, {
            ...(compensation.contextBefore > 0
              ? { contextBefore: compensation.contextBefore }
              : {}),
          }),
        )
        recordMailboxDisclosure(mailboxContinuity, disclosure.mailboxKey, latestMessageAtMs)
        if (compensation.mode !== 'none') {
          log.info({
            mailboxKey: disclosure.mailboxKey,
            mode: compensation.mode,
            contextBefore: compensation.contextBefore,
            elapsedMs: compensation.elapsedMs,
            roundsSince: compensation.roundsSince,
            tokensSince: compensation.tokensSince,
            compactionChanged: compensation.compactionChanged,
          }, 'mailbox_context_compensation_planned')
        }
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
    return disclosed
  }

  async function runRound(goalRoundIndex?: number): Promise<{
    inputTokens: number | null
    tokensUsed: number
    didPause: boolean
    didCompleteRest: boolean
    sentTargets: MessageSentTarget[]
  }> {
    roundIndex++
    let recoveredContextOverflow = false
    let outputContinuations = 0
    let recoveryTokensUsed = 0
    let result: Awaited<ReturnType<typeof runReactRound>>
    while (true) {
      try {
        result = await runReactRound({
          systemPrompt: deps.systemPrompt,
          context: deps.context,
          llm: deps.llm,
          tools: deps.tools,
          toolContext: {
            eventQueue: deps.eventQueue,
            roundIndex,
            ...(goalRoundIndex != null ? { goalRoundIndex } : {}),
          },
        })
        break
      } catch (err) {
        if (err instanceof LlmOutputTruncatedError) {
          recoveryTokensUsed += err.tokensUsed
          const partial = err.completion
          const canContinue =
            outputContinuations < MAX_OUTPUT_CONTINUATIONS_PER_ROUND
            && partial.toolCalls.length === 0
            && partial.content.trim().length > 0
          if (!canContinue) throw err

          deps.context.appendAssistantTurn({
            content: partial.content,
            toolCalls: [],
            ...(partial.nativeBlocks ? { nativeBlocks: partial.nativeBlocks } : {}),
          })
          deps.context.appendUserMessage(OUTPUT_CONTINUATION_PROMPT)
          outputContinuations++
          await saveSnapshot()
          log.warn(
            { roundIndex, outputContinuations },
            'output_truncation_checkpointed_continuing_round',
          )
          continue
        }
        if (recoveredContextOverflow || !isLlmContextOverflowError(err)) throw err
        recoveredContextOverflow = true
        let compacted = false
        try {
          compacted = await compactConversationForRecovery(deps.context, deps.compactOptions)
        } catch (compactionError) {
          log.error({ err: compactionError, roundIndex }, 'context_overflow_compaction_failed')
          throw err
        }
        if (!compacted) throw err
        recordMailboxCompaction(mailboxContinuity)
        const syncedAfterRecoveryCompaction = await syncGoalState()
        if (syncedAfterRecoveryCompaction.goal?.status === 'active') {
          appendGoalContinuation(syncedAfterRecoveryCompaction.goal, 'post_compaction')
        }
        await saveSnapshot()
        log.warn({ roundIndex }, 'context_overflow_compacted_retrying_round')
      }
    }
    const { didPause, didCompleteRest, sentTargets } = interpretToolEffects(result.effects)

    recordMailboxRound(mailboxContinuity, result.inputTokens)
    return {
      inputTokens: result.inputTokens,
      tokensUsed: recoveryTokensUsed + result.tokensUsed,
      didPause,
      didCompleteRest,
      sentTargets,
    }
  }

  function appendHandledMailboxMarkers(sentTargets: readonly MessageSentTarget[]): void {
    const messages = deps.context.getSnapshot().messages
    const seenMailboxes = new Set<string>()
    for (const target of sentTargets) {
      const mailbox = target.type === 'group'
        ? `qq_group:${target.groupId}`
        : `qq_private:${target.userId}`
      if (seenMailboxes.has(mailbox)) continue
      seenMailboxes.add(mailbox)

      const throughRowId = findPendingMailboxThroughRowId(messages, mailbox)
      if (throughRowId == null) continue
      deps.context.appendUserMessage(renderMailboxHandledEvent(mailbox, throughRowId))
    }
  }

  async function saveSnapshot(): Promise<void> {
    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      mailboxCursors,
      mailboxContinuity,
      goalRevision,
      lastWakeAt,
    })
  }

  async function syncGoalState(): Promise<{ goal: AgentGoal | null; appended: boolean }> {
    const goal = await deps.goalStore?.get() ?? null
    if (!goal || goal.revision <= goalRevision) return { goal, appended: false }
    deps.context.appendUserMessage(renderGoalStateEvent(goal))
    goalRevision = goal.revision
    return { goal, appended: true }
  }

  function appendGoalContinuation(goal: AgentGoal, reason: 'automatic_continuation' | 'post_compaction'): void {
    deps.context.appendUserMessage(renderGoalContinuation(goal, reason))
  }

  async function maybeCompact(inputTokens: number | null): Promise<boolean> {
    let compacted = false
    try {
      compacted = await maybeCompactConversation(deps.context, inputTokens, deps.compactOptions)
    } catch (err) {
      log.error({ err }, 'compaction_failed_skipped')
    }
    if (compacted) {
      recordMailboxCompaction(mailboxContinuity)
      try {
        await injectStickerPoolAfterCompaction(deps.context)
      } catch (err) {
        log.warn({ err }, 'sticker_pool_injection_failed')
      }
    }
    return compacted
  }

  async function step(): Promise<{
    ranRound: boolean
    didPause?: boolean
  }> {
    const beforeStepCount = deps.context.getSnapshot().messages.length
    const syncedBeforeEvents = await syncGoalState()
    const goalAtRoundStart = syncedBeforeEvents.goal
    let goalMessagesAppended = syncedBeforeEvents.appended
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
    const drained = drainEvents()
    let disclosed = await discloseEvents(drained.beforeGoal)
    if (goalAtRoundStart?.status === 'active') {
      appendGoalContinuation(goalAtRoundStart, 'automatic_continuation')
      goalMessagesAppended = true
    }
    disclosed += await discloseEvents(drained.afterGoal)
    const appendedInterruptedFocusReminder = drained.hadAttention
      && disclosed > 0
      && shouldAppendInterruptedRestAttentionReminder(deps.context.getSnapshot().messages)
    if (appendedInterruptedFocusReminder) {
      deps.context.appendUserMessage(renderInterruptedRestAttentionReminder())
    }
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: drained.consumed, eventsDisclosed: disclosed }, 'round_start')

    if (drained.consumed > 0 && disclosed === 0 && !goalMessagesAppended && !appendedInterruptedFocusReminder) {
      return { ranRound: false }
    }

    if (deps.context.getSnapshot().messages.length === 0) {
      return { ranRound: false }
    }

    await saveSnapshot()

    const roundStartedAt = Date.now()
    let roundResult: Awaited<ReturnType<typeof runRound>>
    try {
      roundResult = await runRound(
        goalAtRoundStart?.status === 'active' ? goalAtRoundStart.roundsUsed + 1 : undefined,
      )
    } catch (error) {
      if (goalAtRoundStart?.status === 'active' && deps.goalStore && isLlmUsageLimitError(error)) {
        await deps.goalStore.markUsageLimited({
          goalId: goalAtRoundStart.goalId,
          reason: error instanceof Error ? error.message : 'provider usage limit',
        })
        await syncGoalState()
        await saveSnapshot()
      }
      throw error
    }
    const { inputTokens, tokensUsed, didPause, didCompleteRest, sentTargets } = roundResult
    if (goalAtRoundStart?.status === 'active' && deps.goalStore) {
      await deps.goalStore.accountRound({
        goalId: goalAtRoundStart.goalId,
        tokensUsed,
        timeUsedSeconds: Math.max(0, Math.round((Date.now() - roundStartedAt) / 1000)),
      })
      await syncGoalState()
    }
    appendHandledMailboxMarkers(sentTargets)
    await saveSnapshot()
    try {
      const roundMessages = deps.context.getSnapshot().messages.slice(beforeStepCount)
      await deps.lifeJournal?.recordRound({ roundIndex, messages: roundMessages })
    } catch (err) {
      log.warn({ err, roundIndex }, 'life_journal_record_failed_skipped')
    }
    const restReminderNow = didCompleteRest ? autonomy.now() : null
    const shouldAppendRestReminder = restReminderNow != null
      && shouldAppendRestResumeReminder(deps.context.getSnapshot().messages, restReminderNow)
    const compacted = await maybeCompact(inputTokens)
    if (compacted) {
      const syncedAfterCompaction = await syncGoalState()
      if (syncedAfterCompaction.goal?.status === 'active') {
        appendGoalContinuation(syncedAfterCompaction.goal, 'post_compaction')
      }
    }
    let appendedRestResumeReminder = false
    if (shouldAppendRestReminder) {
      deps.context.appendUserMessage(renderRestResumeReminder(restReminderNow))
      appendedRestResumeReminder = true
    }
    if (compacted || appendedRestResumeReminder) {
      await saveSnapshot()
    }
    return { ranRound: true, didPause }
  }

  async function runOnce(): Promise<void> {
    const { ranRound, didPause = false } = await step()
    if (!ranRound && !stopRequested) {
      await waitForExternalEvent()
      return
    }
    if (!ranRound || stopRequested) return

    if (didPause) {
      consecutiveRounds = 0
      return
    }

    consecutiveRounds++
    if (consecutiveRounds >= autonomy.maxConsecutiveRounds) {
      log.info({ consecutiveRounds, cooldownMs: autonomy.cooldownMs }, 'autonomy_round_cooldown_enter')
      await autonomy.waitForAttentionOrTimeout(deps.eventQueue, autonomy.cooldownMs)
      consecutiveRounds = 0
      return
    }
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
    async flush() {
      await syncGoalState()
      await saveSnapshot()
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
  return event.type === 'background_task_completed'
    || event.type === 'scheduled_wake'
    || event.type === 'wake'
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
