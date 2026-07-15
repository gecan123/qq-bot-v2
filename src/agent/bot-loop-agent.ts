import { createAgentContext, type AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { isLlmContextOverflowError, isLlmUsageLimitError, type LlmClient } from './llm-client.js'
import type { MessageSentTarget, ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AgentLedgerLoader } from './agent-ledger-loader.js'
import type { AgentLedgerRepo, AgentRuntimePatch } from './agent-ledger-repo.js'
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
import type { PersistedAgentSnapshot } from './agent-context.types.js'

const log = createLogger('BOT_LOOP')

/** 只供旧单元测试驱动 persistence-first 行为；生产必须使用 AgentLedgerRepo。 */
export interface BotSnapshotRepo {
  load(): Promise<unknown | null>
  save(input: {
    snapshot: PersistedAgentSnapshot
    mailboxCursors: MailboxCursors
    mailboxContinuity?: MailboxContinuityState
    goalRevision: number
    lastWakeAt: Date | null
  }): Promise<void>
}

export interface BotLoopAgentDeps {
  systemPrompt: string
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  tools: ToolExecutor
  /** 生产 canonical 存储；和 ledgerLoader 必须成对提供。 */
  ledgerRepo?: AgentLedgerRepo
  ledgerLoader?: AgentLedgerLoader
  /** 迁移期测试用 persistence-first 适配器。 */
  snapshotRepo?: BotSnapshotRepo
  /** 从持久 snapshot 同行恢复的 per-source 披露游标。 */
  initialMailboxCursors?: Readonly<MailboxCursors>
  /** 与 snapshot 同行恢复的 per-source 上下文新鲜度状态。 */
  initialMailboxContinuity?: MailboxContinuityState
  /** 新来源在尚无 cursor 时使用的旧式恢复边界。 */
  initialLastWakeAt?: Date | null
  /** 与 snapshot 同行恢复的 goal control revision；只控制 LLM 可见状态事件的去重。 */
  initialGoalRevision?: number
  initialLedgerHeadEntryId?: bigint | null
  /** deferred capability 的 round-local 状态，在可见 tool result 提交时同行落盘。 */
  getActiveToolCapabilities?: () => readonly string[]
  syncActiveToolCapabilities?: (capabilities: readonly string[]) => void
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
  idleWaitMs?: number
  actionRetryWaitMs?: number
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
const DEFAULT_AUTONOMY_COOLDOWN_MS = 15 * 60_000
const DEFAULT_IDLE_WAIT_MS = 15 * 60_000
const DEFAULT_ACTION_RETRY_WAIT_MS = 60_000
const MAX_OUTPUT_CONTINUATIONS_PER_ROUND = 2
const MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS = 3
const RECOVERABLE_TOOL_ERROR_CODES = new Set(['capability_inactive', 'invalid_arguments'])
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
  if ((deps.ledgerRepo == null) !== (deps.ledgerLoader == null)) {
    throw new Error('ledgerRepo and ledgerLoader must be provided together')
  }
  if (!deps.ledgerRepo && !deps.snapshotRepo) {
    throw new Error('BotLoopAgent requires ledger persistence')
  }
  const autonomy = {
    maxConsecutiveRounds: Math.max(1, deps.autonomy?.maxConsecutiveRounds ?? DEFAULT_MAX_CONSECUTIVE_ROUNDS),
    cooldownMs: Math.max(1, deps.autonomy?.cooldownMs ?? DEFAULT_AUTONOMY_COOLDOWN_MS),
    idleWaitMs: Math.max(1, deps.autonomy?.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS),
    actionRetryWaitMs: Math.max(1, deps.autonomy?.actionRetryWaitMs ?? DEFAULT_ACTION_RETRY_WAIT_MS),
    now: deps.autonomy?.now ?? (() => new Date()),
    waitForAttentionOrTimeout: deps.autonomy?.waitForAttentionOrTimeout ?? waitForAttentionOrTimeout,
  }
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  let mailboxContinuity = parseMailboxContinuityState(deps.initialMailboxContinuity)
  let goalRevision = Math.max(0, deps.initialGoalRevision ?? 0)
  let ledgerHeadEntryId = deps.initialLedgerHeadEntryId ?? null
  let roundIndex = 0
  let consecutiveRounds = 0
  let noToolActionRetryPending = false
  let recoverableToolCorrectionRounds = 0

  function installRuntimeState(input: {
    mailboxCursors: MailboxCursors
    mailboxContinuity: MailboxContinuityState
    goalRevision: number
    activeToolCapabilities: readonly string[]
    lastWakeAt: Date | null
    ledgerHeadEntryId: bigint | null
  }): void {
    mailboxCursors = { ...input.mailboxCursors }
    mailboxContinuity = parseMailboxContinuityState(input.mailboxContinuity)
    goalRevision = input.goalRevision
    lastWakeAt = input.lastWakeAt == null ? null : new Date(input.lastWakeAt)
    ledgerHeadEntryId = input.ledgerHeadEntryId
    deps.syncActiveToolCapabilities?.(input.activeToolCapabilities)
  }

  function installLegacySnapshot(snapshot: ReturnType<AgentContext['exportPersistedSnapshot']>): void {
    deps.context.replaceMessages(snapshot.messages)
    const current = new Set(deps.context.getSnapshot().activeToolCapabilities)
    const next = new Set(snapshot.activeToolCapabilities)
    for (const capability of current) {
      if (!next.has(capability)) deps.context.deactivateToolCapability(capability)
    }
    for (const capability of next) {
      if (!current.has(capability)) deps.context.activateToolCapability(capability)
    }
  }

  async function reloadProjectionFromCanonical(): Promise<void> {
    const loaded = await deps.ledgerLoader!.load()
    deps.context.installProjection(loaded.projection.snapshot)
    installRuntimeState(loaded.runtimeState)
  }

  async function commitChanges(input: {
    messages?: readonly AgentMessage[]
    runtimePatch?: AgentRuntimePatch
  }): Promise<void> {
    const messages = input.messages ?? []
    if (messages.length === 0 && input.runtimePatch == null) return

    try {
      if (deps.ledgerRepo) {
        if (messages.length > 0) {
          await deps.ledgerRepo.appendMessages({
            messages,
            ...(input.runtimePatch ? { runtimePatch: input.runtimePatch } : {}),
          })
        } else {
          await deps.ledgerRepo.updateRuntime({
            expectedHeadEntryId: ledgerHeadEntryId,
            patch: input.runtimePatch!,
          })
        }
        await reloadProjectionFromCanonical()
        return
      }

      // 旧测试仓储也遵守 persistence-first：先保存目标投影，成功后才安装到内存。
      const current = deps.context.exportPersistedSnapshot()
      const runtimePatch = input.runtimePatch ?? {}
      const nextSnapshot = {
        ...current,
        messages: [...current.messages, ...structuredClone(messages)],
        activeToolCapabilities: runtimePatch.activeToolCapabilities == null
          ? current.activeToolCapabilities
          : [...runtimePatch.activeToolCapabilities],
      }
      const nextRuntime = {
        mailboxCursors: runtimePatch.mailboxCursors ?? mailboxCursors,
        mailboxContinuity: runtimePatch.mailboxContinuity ?? mailboxContinuity,
        goalRevision: runtimePatch.goalRevision ?? goalRevision,
        activeToolCapabilities: runtimePatch.activeToolCapabilities
          ?? current.activeToolCapabilities,
        lastWakeAt: runtimePatch.lastWakeAt === undefined ? lastWakeAt : runtimePatch.lastWakeAt,
        ledgerHeadEntryId,
      }
      await deps.snapshotRepo!.save({
        snapshot: nextSnapshot,
        mailboxCursors: nextRuntime.mailboxCursors,
        mailboxContinuity: nextRuntime.mailboxContinuity,
        goalRevision: nextRuntime.goalRevision,
        lastWakeAt: nextRuntime.lastWakeAt,
      })
      installLegacySnapshot(nextSnapshot)
      installRuntimeState(nextRuntime)
    } catch (error) {
      // deferred capability callbacks only mutate round-local host state; roll it back
      // when its paired visible tool result cannot be committed.
      deps.syncActiveToolCapabilities?.(deps.context.getSnapshot().activeToolCapabilities)
      throw error
    }
  }

  function drainEvents(): {
    consumed: number
    hadAttention: boolean
    beforeGoal: MailboxDisclosure[]
    afterGoal: MailboxDisclosure[]
    cursors: MailboxCursors
    events: BotEvent[]
  } {
    const events: BotEvent[] = []
    while (true) {
      const event = deps.eventQueue.dequeue()
      if (!event) break
      events.push(event)
    }

    const plan = planMailboxDisclosures(events, mailboxCursors)
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
      cursors: plan.cursors,
      events,
    }
  }

  async function discloseEvents(
    disclosures: readonly MailboxDisclosure[],
    messages: AgentMessage[],
    continuity: MailboxContinuityState,
    wakeState: { lastWakeAt: Date | null },
  ): Promise<number> {
    let disclosed = 0
    for (const disclosure of disclosures) {
      if (disclosure.kind === 'backlog') {
        messages.push({ role: 'user', content: renderMailboxBacklogNotification(disclosure.event) })
        recordMailboxDisclosure(
          continuity,
          disclosure.event.mailboxKey,
          disclosure.event.timeRange.to.getTime(),
        )
        disclosed++
        wakeState.lastWakeAt = new Date()
        continue
      }

      if (disclosure.kind === 'mailbox') {
        const latestMessageAtMs = disclosure.events.at(-1)!.sentAt.getTime()
        const compensation = decideMailboxCompensation(
          continuity,
          disclosure.mailboxKey,
          latestMessageAtMs,
        )
        messages.push({
          role: 'user',
          content: renderMailboxNotification(disclosure.mailboxKey, disclosure.events, {
            ...(compensation.contextBefore > 0
              ? { contextBefore: compensation.contextBefore }
              : {}),
          }),
        })
        recordMailboxDisclosure(continuity, disclosure.mailboxKey, latestMessageAtMs)
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
        wakeState.lastWakeAt = new Date()
        continue
      }

      if (disclosure.event.type === 'wake') continue
      const rendered = await deps.renderEvent(disclosure.event)
      if (rendered == null || rendered.length === 0) continue
      messages.push({ role: 'user', content: rendered })
      disclosed++
      if (
        disclosure.event.type === 'napcat_message' ||
        disclosure.event.type === 'napcat_private_message'
      ) {
        wakeState.lastWakeAt = new Date()
      }
    }
    return disclosed
  }

  async function runRound(goalRoundIndex?: number): Promise<{
    inputTokens: number | null
    tokensUsed: number
    toolCallCount: number
    didPause: boolean
    didCompleteRest: boolean
    sentTargets: MessageSentTarget[]
    recoverableToolFailure: boolean
    onlyHelpToolCalls: boolean
  }> {
    roundIndex++
    let recoveredContextOverflow = false
    let outputContinuations = 0
    let recoveryTokensUsed = 0
    const stagedMessages: AgentMessage[] = []
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
          stagedMessages,
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

          stagedMessages.push({
            role: 'assistant',
            content: partial.content,
            toolCalls: [],
            ...(partial.nativeBlocks ? { nativeBlocks: partial.nativeBlocks } : {}),
          })
          stagedMessages.push({ role: 'user', content: OUTPUT_CONTINUATION_PROMPT })
          outputContinuations++
          log.warn(
            { roundIndex, outputContinuations },
            'output_truncation_checkpointed_continuing_round',
          )
          continue
        }
        if (recoveredContextOverflow || !isLlmContextOverflowError(err)) throw err
        recoveredContextOverflow = true
        if (deps.ledgerRepo) throw err
        const recoveryContext = createAgentContext()
        recoveryContext.replaceMessages(deps.context.getSnapshot().messages)
        let compacted = false
        try {
          compacted = await compactConversationForRecovery(recoveryContext, deps.compactOptions)
        } catch (compactionError) {
          log.error({ err: compactionError, roundIndex }, 'context_overflow_compaction_failed')
          throw err
        }
        if (!compacted) throw err
        const nextContinuity = parseMailboxContinuityState(mailboxContinuity)
        recordMailboxCompaction(nextContinuity)
        const nextSnapshot = recoveryContext.exportPersistedSnapshot()
        await deps.snapshotRepo!.save({
          snapshot: nextSnapshot,
          mailboxCursors,
          mailboxContinuity: nextContinuity,
          goalRevision,
          lastWakeAt,
        })
        installLegacySnapshot(nextSnapshot)
        mailboxContinuity = nextContinuity
        const syncedAfterRecoveryCompaction = await syncGoalState()
        if (syncedAfterRecoveryCompaction.goal?.status === 'active') {
          await appendGoalContinuation(syncedAfterRecoveryCompaction.goal, 'post_compaction')
        }
        log.warn({ roundIndex }, 'context_overflow_compacted_retrying_round')
      }
    }
    const { didPause, didCompleteRest, sentTargets } = interpretToolEffects(result.effects)

    stagedMessages.push(...result.messagesToAppend)
    const nextContinuity = parseMailboxContinuityState(mailboxContinuity)
    recordMailboxRound(nextContinuity, result.inputTokens)
    await commitChanges({
      messages: stagedMessages,
      runtimePatch: {
        mailboxContinuity: nextContinuity,
        ...(deps.getActiveToolCapabilities
          ? { activeToolCapabilities: [...deps.getActiveToolCapabilities()] }
          : {}),
      },
    })
    return {
      inputTokens: result.inputTokens,
      tokensUsed: recoveryTokensUsed + result.tokensUsed,
      toolCallCount: result.toolCallCount,
      didPause,
      didCompleteRest,
      sentTargets,
      recoverableToolFailure: result.toolOutcomes.some((outcome) => (
        !outcome.ok && outcome.code != null && RECOVERABLE_TOOL_ERROR_CODES.has(outcome.code)
      )),
      onlyHelpToolCalls: result.toolOutcomes.length > 0
        && result.toolOutcomes.every((outcome) => outcome.requestedToolName === 'help'),
    }
  }

  function collectHandledMailboxMarkers(sentTargets: readonly MessageSentTarget[]): AgentMessage[] {
    const messages = deps.context.getSnapshot().messages
    const seenMailboxes = new Set<string>()
    const markers: AgentMessage[] = []
    for (const target of sentTargets) {
      const mailbox = target.type === 'group'
        ? `qq_group:${target.groupId}`
        : `qq_private:${target.userId}`
      if (seenMailboxes.has(mailbox)) continue
      seenMailboxes.add(mailbox)

      const throughRowId = findPendingMailboxThroughRowId(messages, mailbox)
      if (throughRowId == null) continue
      markers.push({ role: 'user', content: renderMailboxHandledEvent(mailbox, throughRowId) })
    }
    return markers
  }

  async function syncGoalState(): Promise<{ goal: AgentGoal | null; appended: boolean }> {
    const goal = await deps.goalStore?.get() ?? null
    if (!goal || goal.revision <= goalRevision) return { goal, appended: false }
    await commitChanges({
      messages: [{ role: 'user', content: renderGoalStateEvent(goal) }],
      runtimePatch: { goalRevision: goal.revision },
    })
    return { goal, appended: true }
  }

  async function appendGoalContinuation(
    goal: AgentGoal,
    reason: 'automatic_continuation' | 'post_compaction',
  ): Promise<void> {
    await commitChanges({
      messages: [{ role: 'user', content: renderGoalContinuation(goal, reason) }],
    })
  }

  async function maybeCompact(inputTokens: number | null): Promise<boolean> {
    // 新 ledger 的 compaction entry 在 Task 7/8 接入；这里仅保留旧测试仓储的
    // persistence-first 路径，绝不先改正式 AgentContext。
    if (deps.ledgerRepo) return false
    const workingContext = createAgentContext()
    workingContext.replaceMessages(deps.context.getSnapshot().messages)
    let compacted = false
    try {
      compacted = await maybeCompactConversation(workingContext, inputTokens, deps.compactOptions)
    } catch (err) {
      log.error({ err }, 'compaction_failed_skipped')
    }
    if (compacted) {
      const nextContinuity = parseMailboxContinuityState(mailboxContinuity)
      recordMailboxCompaction(nextContinuity)
      try {
        await injectStickerPoolAfterCompaction(workingContext)
      } catch (err) {
        log.warn({ err }, 'sticker_pool_injection_failed')
      }
      const nextSnapshot = workingContext.exportPersistedSnapshot()
      await deps.snapshotRepo!.save({
        snapshot: nextSnapshot,
        mailboxCursors,
        mailboxContinuity: nextContinuity,
        goalRevision,
        lastWakeAt,
      })
      installLegacySnapshot(nextSnapshot)
      mailboxContinuity = nextContinuity
    }
    return compacted
  }

  async function step(): Promise<{
    ranRound: boolean
    didPause?: boolean
    toolCallCount?: number
    actionRequired?: boolean
    recoverableToolFailure?: boolean
    onlyHelpToolCalls?: boolean
  }> {
    const beforeStepCount = deps.context.getSnapshot().messages.length
    const goalAtRoundStart = await deps.goalStore?.get() ?? null
    const stagedMessages: AgentMessage[] = []
    const stagedContinuity = parseMailboxContinuityState(mailboxContinuity)
    const stagedWake = { lastWakeAt }
    let nextGoalRevision = goalRevision
    let goalMessagesAppended = false
    if (goalAtRoundStart && goalAtRoundStart.revision > goalRevision) {
      stagedMessages.push({ role: 'user', content: renderGoalStateEvent(goalAtRoundStart) })
      nextGoalRevision = goalAtRoundStart.revision
      goalMessagesAppended = true
    }
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
    let disclosed = await discloseEvents(
      drained.beforeGoal,
      stagedMessages,
      stagedContinuity,
      stagedWake,
    )
    if (goalAtRoundStart?.status === 'active') {
      stagedMessages.push({
        role: 'user',
        content: renderGoalContinuation(goalAtRoundStart, 'automatic_continuation'),
      })
      goalMessagesAppended = true
    }
    disclosed += await discloseEvents(
      drained.afterGoal,
      stagedMessages,
      stagedContinuity,
      stagedWake,
    )
    const visibleMessages = [...deps.context.getSnapshot().messages, ...stagedMessages]
    const appendedInterruptedFocusReminder = drained.hadAttention
      && disclosed > 0
      && shouldAppendInterruptedRestAttentionReminder(visibleMessages)
    if (appendedInterruptedFocusReminder) {
      stagedMessages.push({ role: 'user', content: renderInterruptedRestAttentionReminder() })
    }
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: drained.consumed, eventsDisclosed: disclosed }, 'round_start')

    const cursorsChanged = JSON.stringify(drained.cursors) !== JSON.stringify(mailboxCursors)
    if (stagedMessages.length > 0 || cursorsChanged || nextGoalRevision !== goalRevision) {
      try {
        await commitChanges({
          messages: stagedMessages,
          runtimePatch: {
            mailboxCursors: drained.cursors,
            mailboxContinuity: stagedContinuity,
            goalRevision: nextGoalRevision,
            lastWakeAt: stagedWake.lastWakeAt,
          },
        })
      } catch (error) {
        for (const event of drained.events) deps.eventQueue.enqueue(event)
        throw error
      }
    }

    if (drained.consumed > 0 && disclosed === 0 && !goalMessagesAppended && !appendedInterruptedFocusReminder) {
      return { ranRound: false }
    }

    if (deps.context.getSnapshot().messages.length === 0) {
      return { ranRound: false }
    }

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
      }
      throw error
    }
    const {
      inputTokens,
      tokensUsed,
      toolCallCount,
      didPause,
      didCompleteRest,
      sentTargets,
      recoverableToolFailure,
      onlyHelpToolCalls,
    } = roundResult
    const handledMailboxMarkers = collectHandledMailboxMarkers(sentTargets)
    await commitChanges({ messages: handledMailboxMarkers })
    if (goalAtRoundStart?.status === 'active' && deps.goalStore) {
      await deps.goalStore.accountRound({
        goalId: goalAtRoundStart.goalId,
        tokensUsed,
        timeUsedSeconds: Math.max(0, Math.round((Date.now() - roundStartedAt) / 1000)),
      })
      await syncGoalState()
    }
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
        await appendGoalContinuation(syncedAfterCompaction.goal, 'post_compaction')
      }
    }
    if (shouldAppendRestReminder) {
      await commitChanges({
        messages: [{ role: 'user', content: renderRestResumeReminder(restReminderNow) }],
      })
    }
    return {
      ranRound: true,
      didPause,
      toolCallCount,
      recoverableToolFailure,
      onlyHelpToolCalls,
      actionRequired: goalAtRoundStart?.status === 'active' || (drained.hadAttention && disclosed > 0),
    }
  }

  async function runOnce(): Promise<void> {
    const {
      ranRound,
      didPause = false,
      toolCallCount = 0,
      actionRequired = false,
      recoverableToolFailure = false,
      onlyHelpToolCalls = false,
    } = await step()
    if (!ranRound && !stopRequested) {
      await waitForExternalEvent()
      return
    }
    if (!ranRound || stopRequested) return

    if (didPause) {
      consecutiveRounds = 0
      noToolActionRetryPending = false
      recoverableToolCorrectionRounds = 0
      return
    }

    consecutiveRounds++
    if (consecutiveRounds >= autonomy.maxConsecutiveRounds) {
      const continuingCorrection = recoverableToolFailure
        || (recoverableToolCorrectionRounds > 0 && onlyHelpToolCalls)
      if (
        continuingCorrection
        && recoverableToolCorrectionRounds < MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS
      ) {
        recoverableToolCorrectionRounds++
        noToolActionRetryPending = false
        log.info({
          consecutiveRounds,
          correctionRound: recoverableToolCorrectionRounds,
          maxCorrectionRounds: MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS,
          recoverableToolFailure,
          onlyHelpToolCalls,
        }, 'recoverable_tool_error_retry_immediate')
        return
      }
      log.info({ consecutiveRounds, cooldownMs: autonomy.cooldownMs }, 'autonomy_round_cooldown_enter')
      await autonomy.waitForAttentionOrTimeout(deps.eventQueue, autonomy.cooldownMs)
      consecutiveRounds = 0
      noToolActionRetryPending = false
      recoverableToolCorrectionRounds = 0
      return
    }

    if (toolCallCount > 0) {
      noToolActionRetryPending = false
      return
    }

    if (actionRequired || noToolActionRetryPending) {
      if (!noToolActionRetryPending) {
        noToolActionRetryPending = true
        log.info({ consecutiveRounds }, 'no_tool_action_retry_immediate')
        return
      }
      log.info(
        { consecutiveRounds, waitMs: autonomy.actionRetryWaitMs },
        'no_tool_action_retry_wait',
      )
      await autonomy.waitForAttentionOrTimeout(deps.eventQueue, autonomy.actionRetryWaitMs)
      noToolActionRetryPending = false
      return
    }

    log.info({ consecutiveRounds, waitMs: autonomy.idleWaitMs }, 'no_tool_quiescent_wait')
    await autonomy.waitForAttentionOrTimeout(deps.eventQueue, autonomy.idleWaitMs)
    consecutiveRounds = 0
    recoverableToolCorrectionRounds = 0
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
      if (!deps.ledgerRepo && deps.snapshotRepo) {
        await deps.snapshotRepo.save({
          snapshot: deps.context.exportPersistedSnapshot(),
          mailboxCursors,
          mailboxContinuity,
          goalRevision,
          lastWakeAt,
        })
      }
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
