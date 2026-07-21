import type { AgentContext } from './agent-context.js'
import type { AgentMessage, QqConversationFocus } from './agent-context.types.js'
import { isLlmContextOverflowError, isLlmUsageLimitError, type LlmClient } from './llm-client.js'
import type { MessageSentTarget, ToolContinuation, ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AgentLedgerLoader } from './agent-ledger-loader.js'
import {
  AgentLedgerHeadChangedError,
  type AgentLedgerRepo,
  type AgentRuntimePatch,
} from './agent-ledger-repo.js'
import {
  createCompactionCandidate,
  prepareCompaction,
  summarizeCachedClaudeCompaction,
  summarizeCompactionCandidate,
  type MaybeCompactOptions,
} from './compaction.js'
import { LlmOutputTruncatedError, runReactRound, type ReactToolOutcome } from './react-kernel.js'
import { interpretToolEffects } from './effect-interpreter.js'
import {
  renderInterruptedRestAttentionReminder,
  renderRestResumeReminder,
  captureRestResumeCompactionState,
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
  hasPendingPrivateMailboxAttention,
  renderMailboxHandledEvent,
} from './mailbox-handled.js'
import { projectAgentLedger } from './agent-ledger-projection.js'
import type {
  CompactionAgentLedgerEntry,
  CompactionReason,
} from './agent-ledger.types.js'
import { runAfterCompactHook } from './compaction-hooks.js'
import { config } from '../config/index.js'
import type { GroupParticipation } from '../config/group-policies.js'
import { estimateLedgerContextTokens } from './compaction-token-estimator.js'
import { buildWorkingContextProjection } from './working-context.js'
import {
  advanceInboxReadCursor,
  type InboxReadCursors,
} from './inbox-read-cursors.js'
import type { AgentActivityReporter, AgentActivityTrigger } from './activity-surface.js'
import {
  renderShareCheckpoint,
  selectShareCheckpointCandidate,
  type ActiveGroupShareTarget,
} from './share-checkpoint.js'
import {
  isAttentionEvent,
  notificationRoutingForEvent,
} from './notification.js'

const log = createLogger('BOT_LOOP')

export interface BotLoopAgentDeps {
  systemPrompt: string
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  tools: ToolExecutor
  /** 唯一 canonical 存储及其确定性 loader。 */
  ledgerRepo: AgentLedgerRepo
  ledgerLoader: AgentLedgerLoader
  /** 从 runtime singleton 恢复的 per-source 披露游标。 */
  initialMailboxCursors?: Readonly<MailboxCursors>
  /** inbox 工具已读取到的 per-source row cursor；普通群消息只经此游标消费。 */
  initialInboxReadCursors?: Readonly<InboxReadCursors>
  syncInboxReadCursors?: (cursors: Readonly<InboxReadCursors>) => void
  /** 从 runtime singleton 恢复的 per-source 上下文新鲜度状态。 */
  initialMailboxContinuity?: MailboxContinuityState
  /** 新来源在尚无 cursor 时使用的旧式恢复边界。 */
  initialLastWakeAt?: Date | null
  /** 从 runtime singleton 恢复的 goal control revision；只控制 LLM 可见状态事件的去重。 */
  initialGoalRevision?: number
  initialLedgerHeadEntryId?: bigint | null
  /** deferred capability 的 round-local 状态，在可见 tool result 提交时同行落盘。 */
  getActiveToolCapabilities?: () => readonly string[]
  syncActiveToolCapabilities?: (capabilities: readonly string[]) => void
  /** QQ 会话焦点也是 runtime control state，与可见 tool result 同事务落盘。 */
  getQqConversationFocus?: () => QqConversationFocus
  syncQqConversationFocus?: (focus: QqConversationFocus) => void
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
  /** 运行时自主循环保护；不进入 ledger 或 runtime singleton。 */
  autonomy?: BotLoopAutonomyOptions
  /** 启动期冻结的群参与节奏；只作为 QQ notification 的软提示，不改变发送授权。 */
  groupParticipations?: ReadonlyMap<number, GroupParticipation>
  /** active 群的稳定短定位；只用于成果后的单次分享判断，不改变唤醒或发送授权。 */
  activeGroupShareTargets?: readonly ActiveGroupShareTarget[]
  /** 可选的 Life Journal 自省 hook；输出不进入 AgentContext。 */
  lifeJournal?: BotLoopLifeJournal
  /** 可丢弃的实时活动观察面；不进入 ledger/runtime singleton。 */
  activityReporter?: AgentActivityReporter
}

export interface BotLoopLifeJournal {
  recordRound(input: {
    roundIndex: number
    messages: AgentMessage[]
    evidenceMessageRowIds?: number[]
  }): Promise<unknown>
}

export interface BotLoopAutonomyOptions {
  idleWaitMs?: number
  maxIdleWaitMs?: number
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
const DEFAULT_IDLE_WAIT_MS = 15 * 60_000
const DEFAULT_MAX_IDLE_WAIT_MS = 4 * 60 * 60_000
const DEFAULT_ACTION_RETRY_WAIT_MS = 60_000
const DEFAULT_COMPACTION_FAILURE_BACKOFF_MS = 10 * 60_000
const MAX_OUTPUT_CONTINUATIONS_PER_ROUND = 2
const MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS = 3
const MAX_RECENT_TOOL_NOVELTY_KEYS = 256
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
  requestManualCompaction(focus?: string): Promise<boolean>
  /** 测试用:跑一次 runOnce 不进入 while 循环。 */
  runOnceForTest(): Promise<void>
}

export function createBotLoopAgent(deps: BotLoopAgentDeps): BotLoopAgent {
  const idleWaitMs = Math.max(1, deps.autonomy?.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS)
  const autonomy = {
    idleWaitMs,
    maxIdleWaitMs: Math.max(idleWaitMs, deps.autonomy?.maxIdleWaitMs ?? DEFAULT_MAX_IDLE_WAIT_MS),
    actionRetryWaitMs: Math.max(1, deps.autonomy?.actionRetryWaitMs ?? DEFAULT_ACTION_RETRY_WAIT_MS),
    now: deps.autonomy?.now ?? (() => new Date()),
    waitForAttentionOrTimeout: deps.autonomy?.waitForAttentionOrTimeout ?? waitForAttentionOrTimeout,
  }
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  let inboxReadCursors: InboxReadCursors = { ...deps.initialInboxReadCursors }
  let mailboxContinuity = parseMailboxContinuityState(deps.initialMailboxContinuity)
  let goalRevision = Math.max(0, deps.initialGoalRevision ?? 0)
  let ledgerHeadEntryId = deps.initialLedgerHeadEntryId ?? null
  let roundIndex = 0
  let consecutiveRounds = 0
  let actionCorrectionRetryPending = false
  let recoverableToolCorrectionRounds = 0
  let idleBackoffLevel = 0
  const recentToolNoveltyKeys = new Map<string, number>()
  let nextCompactionAttemptAt = 0
  let compactionAbortController = new AbortController()
  let lastContextWindowTokens =
    config.llm.contextWindowTokensByModel[config.llm.defaultModel] ?? 200_000

  function installRuntimeState(input: {
    mailboxCursors: MailboxCursors
    inboxReadCursors: InboxReadCursors
    mailboxContinuity: MailboxContinuityState
    goalRevision: number
    activeToolCapabilities: readonly string[]
    qqConversationFocus: QqConversationFocus
    lastWakeAt: Date | null
    ledgerHeadEntryId: bigint | null
  }): void {
    mailboxCursors = { ...input.mailboxCursors }
    inboxReadCursors = { ...input.inboxReadCursors }
    mailboxContinuity = parseMailboxContinuityState(input.mailboxContinuity)
    goalRevision = input.goalRevision
    lastWakeAt = input.lastWakeAt == null ? null : new Date(input.lastWakeAt)
    ledgerHeadEntryId = input.ledgerHeadEntryId
    deps.syncActiveToolCapabilities?.(input.activeToolCapabilities)
    deps.syncQqConversationFocus?.(input.qqConversationFocus)
    deps.syncInboxReadCursors?.(input.inboxReadCursors)
  }

  async function reloadProjectionFromCanonical(): Promise<void> {
    const loaded = await deps.ledgerLoader.load()
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
    } catch (error) {
      // deferred capability callbacks only mutate round-local host state; roll it back
      // when its paired visible tool result cannot be committed.
      deps.syncActiveToolCapabilities?.(deps.context.getSnapshot().activeToolCapabilities)
      deps.syncQqConversationFocus?.(deps.context.getSnapshot().qqConversationFocus)
      deps.syncInboxReadCursors?.(inboxReadCursors)
      throw error
    }
  }

  async function compactCanonical(input: {
    reason: CompactionReason
    contextTokens: number
    contextWindowTokens: number
    providerPrefixHeadEntryId?: bigint | null
    manualFocus?: string
  }): Promise<boolean> {
    if (!deps.ledgerRepo || !deps.ledgerLoader) return false
    const options = deps.compactOptions ?? {}
    const nowMs = options.nowMs ?? Date.now
    if (input.reason === 'threshold' && nowMs() < nextCompactionAttemptAt) {
      log.debug({ retryAfterMs: nextCompactionAttemptAt - nowMs() }, 'compaction_failure_backoff_skipped')
      return false
    }
    const recordThresholdFailure = (reason: string): void => {
      if (input.reason !== 'threshold') return
      nextCompactionAttemptAt = nowMs()
        + Math.max(1, options.failureBackoffMs ?? DEFAULT_COMPACTION_FAILURE_BACKOFF_MS)
      log.warn({ reason, nextCompactionAttemptAt }, 'canonical_compaction_backoff_recorded')
    }
    const reserveTokens = options.reserveTokens
      ?? (options.triggerTokens == null
        ? config.compaction.reserveTokens
        : Math.max(0, input.contextWindowTokens - options.triggerTokens))
    const keepRecentTokens = options.keepRecentTokens ?? config.compaction.keepRecentTokens
    if (
      input.reason === 'threshold'
      && input.providerPrefixHeadEntryId == null
      && input.contextTokens <= Math.max(0, input.contextWindowTokens - reserveTokens)
    ) {
      return false
    }

    for (let headAttempt = 0; headAttempt < 2; headAttempt++) {
      const canonical = await deps.ledgerRepo.loadCanonicalState()
      const effectiveContextTokens = input.reason === 'threshold'
        && input.providerPrefixHeadEntryId != null
        ? estimateLedgerContextTokens({
            entries: canonical.entries,
            providerPrefix: {
              throughEntryId: input.providerPrefixHeadEntryId,
              inputTokens: input.contextTokens,
            },
          }).tokens
        : input.contextTokens
      if (
        input.reason === 'threshold'
        && effectiveContextTokens <= Math.max(0, input.contextWindowTokens - reserveTokens)
      ) {
        return false
      }
      const latestProjection = projectAgentLedger({
        entries: canonical.entries,
        runtimeState: canonical.runtimeState,
      })
      const previousCompaction = [...canonical.entries]
        .reverse()
        .find((entry): entry is CompactionAgentLedgerEntry => entry.entryType === 'compaction')
        ?? null
      const preparation = prepareCompaction({
        entries: canonical.entries,
        latestProjection,
        previousCompaction,
        contextTokens: effectiveContextTokens,
        contextWindowTokens: input.contextWindowTokens,
        reserveTokens,
        keepRecentTokens,
        reason: input.reason,
        ...(input.manualFocus == null ? {} : { manualFocus: input.manualFocus }),
      })
      if (preparation == null) return false
      if (preparation.status !== 'ready') {
        recordThresholdFailure(preparation.reason)
        return false
      }

      let candidate: Awaited<ReturnType<typeof createCompactionCandidate>>
      const compactedContinuity = parseMailboxContinuityState(
        canonical.runtimeState.mailboxContinuity,
      )
      recordMailboxCompaction(compactedContinuity)
      const candidateRuntimeState = {
        ...canonical.runtimeState,
        mailboxContinuity: compactedContinuity,
      }
      try {
        let summarize = options.summarizeCandidate
        if (summarize == null && deps.llm.provider === 'claude-code' && !preparation.isSplitTurn) {
          const activeMessageCount = preparation.entriesToSummarize.length
            + preparation.tailEntries.length
          const syntheticMessageCount = latestProjection.snapshot.messages.length
            - activeMessageCount
          const prefixMessageCount = syntheticMessageCount
            + preparation.entriesToSummarize.length
          if (
            syntheticMessageCount < 0
            || prefixMessageCount <= 0
            || prefixMessageCount >= latestProjection.snapshot.messages.length
          ) {
            throw new Error('cached Claude compaction prefix does not match canonical projection')
          }
          const workingProjection = await buildWorkingContextProjection(
            latestProjection.snapshot.messages,
          )
          const cachedPrefix = workingProjection.messages.slice(0, prefixMessageCount)
          const visibleTools = deps.tools.list()
          summarize = (_request, { signal }) => summarizeCachedClaudeCompaction({
            llm: deps.llm,
            systemPrompt: deps.systemPrompt,
            messages: cachedPrefix,
            tools: visibleTools,
            ...(preparation.manualFocus == null
              ? {}
              : { manualFocus: preparation.manualFocus }),
            ...(options.maxSummaryTokens == null
              ? {}
              : { maxSummaryTokens: options.maxSummaryTokens }),
            signal,
          })
        }
        summarize ??= (request, { signal }) => summarizeCompactionCandidate(request, {
          signal,
          llm: deps.llm,
        })
        candidate = await createCompactionCandidate({
          entries: canonical.entries,
          runtimeState: candidateRuntimeState,
          preparation,
          summarize,
          hooks: options.hooks,
          signal: compactionAbortController.signal,
          maxSummaryTokens: options.maxSummaryTokens,
          restResumeState: captureRestResumeCompactionState(latestProjection.snapshot.messages),
        })
      } catch (err) {
        recordThresholdFailure('summarizer_failed')
        log.error({ err, reason: input.reason }, 'canonical_compaction_candidate_failed')
        return false
      }
      if (candidate.status !== 'ready') {
        if (candidate.status !== 'cancelled' || candidate.reason !== 'aborted') {
          recordThresholdFailure(candidate.reason)
        }
        return false
      }

      try {
        const committed = await deps.ledgerRepo.appendCompaction({
          expectedHeadEntryId: preparation.expectedHeadEntryId,
          payload: candidate.payload,
          runtimePatch: { mailboxContinuity: compactedContinuity },
        })
        const committedEntry = committed.appendedEntries.find(
          (entry): entry is CompactionAgentLedgerEntry => entry.entryType === 'compaction',
        )
        if (!committedEntry) throw new Error('compaction commit returned no compaction entry')

        // CAS makes the validated candidate authoritative. Install immediately;
        // loader then refreshes the disposable checkpoint best-effort.
        deps.context.installProjection(candidate.projection.snapshot)
        installRuntimeState(committed.runtimeState)
        try {
          await reloadProjectionFromCanonical()
        } catch (err) {
          log.warn({ err }, 'post_compaction_reload_failed_committed_projection_retained')
        }
        nextCompactionAttemptAt = 0
        await runAfterCompactHook(options.hooks ?? {}, {
          committedEntry,
          metrics: {
            tokensBefore: candidate.payload.tokensBefore,
            estimatedTokensAfter: candidate.payload.estimatedTokensAfter,
            compressedEntryCount: preparation.entriesToSummarize.length,
            keptEntryCount: preparation.tailEntries.length,
          },
        }, (error) => log.warn({ error }, 'after_compact_hook_failed'))
        log.info({
          reason: input.reason,
          committedEntryId: committedEntry.id,
          tokensBefore: candidate.payload.tokensBefore,
          estimatedTokensAfter: candidate.payload.estimatedTokensAfter,
        }, 'canonical_compaction_committed')
        return true
      } catch (err) {
        if (err instanceof AgentLedgerHeadChangedError && headAttempt === 0) {
          log.info({
            expectedHeadEntryId: err.expectedHeadEntryId,
            actualHeadEntryId: err.actualHeadEntryId,
          }, 'canonical_compaction_head_changed_recalculating')
          continue
        }
        recordThresholdFailure(err instanceof AgentLedgerHeadChangedError ? 'head_changed' : 'commit_failed')
        log.error({ err, reason: input.reason }, 'canonical_compaction_commit_failed')
        return false
      }
    }
    return false
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
    const highInterruptingDisclosures: MailboxDisclosure[] = []
    const normalInterruptingDisclosures: MailboxDisclosure[] = []
    const ordinaryDisclosures: MailboxDisclosure[] = []
    for (const disclosure of plan.disclosures) {
      if (isHighPriorityMailboxDisclosure(disclosure)) {
        highInterruptingDisclosures.push(disclosure)
        continue
      }
      const routing = disclosure.kind === 'direct'
        ? notificationRoutingForEvent(disclosure.event)
        : null
      if (routing?.delivery === 'interrupt') {
        if (routing.priority === 'high') highInterruptingDisclosures.push(disclosure)
        else normalInterruptingDisclosures.push(disclosure)
      } else {
        ordinaryDisclosures.push(disclosure)
      }
    }
    return {
      consumed: events.length,
      hadAttention: events.some(isAttentionEvent),
      beforeGoal: [...highInterruptingDisclosures, ...normalInterruptingDisclosures],
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
        const participation = disclosure.event.source.type === 'group'
          ? deps.groupParticipations?.get(disclosure.event.source.groupId)
          : undefined
        messages.push({
          role: 'user',
          content: renderMailboxBacklogNotification(
            disclosure.event,
            participation ? { participation } : {},
          ),
        })
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
        const firstEvent = disclosure.events[0]!
        const participation = firstEvent.type === 'napcat_message'
          ? deps.groupParticipations?.get(firstEvent.groupId)
          : undefined
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
            ...(participation ? { participation } : {}),
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
    contextWindowTokens: number
    providerPrefixHeadEntryId: bigint | null
    tokensUsed: number
    toolCallCount: number
    didPause: boolean
    didCompleteRest: boolean
    sentTargets: MessageSentTarget[]
    recoverableToolFailure: boolean
    onlyHelpToolCalls: boolean
    madeToolProgress: boolean
    evidenceMessageRowIds: number[]
    toolOutcomes: ReactToolOutcome[]
    toolContinuation?: ToolContinuation
    toolContinuationDetail?: string
  }> {
    roundIndex++
    let recoveredContextOverflow = false
    let outputContinuations = 0
    let recoveryTokensUsed = 0
    const stagedMessages: AgentMessage[] = []
    let result: Awaited<ReturnType<typeof runReactRound>>
    let providerPrefixHeadEntryId = ledgerHeadEntryId
    while (true) {
      try {
        providerPrefixHeadEntryId = ledgerHeadEntryId
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
          compactionKeepRecentTokens:
            deps.compactOptions?.keepRecentTokens ?? config.compaction.keepRecentTokens,
        })
        deps.activityReporter?.setPhase({
          phase: 'committing',
          roundIndex,
          detail: '正在保存本轮结果',
        })
        lastContextWindowTokens = result.contextWindowTokens
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
        const overflowContextWindow = resolveOverflowContextWindowTokens(
          err,
          lastContextWindowTokens,
        )
        const compacted = await compactCanonical({
          reason: 'overflow',
          contextTokens: overflowContextWindow,
          contextWindowTokens: overflowContextWindow,
        })
        if (!compacted) throw err
        const syncedAfterRecoveryCompaction = await syncGoalState()
        if (syncedAfterRecoveryCompaction.goal?.status === 'active') {
          await appendGoalContinuation(syncedAfterRecoveryCompaction.goal, 'post_compaction')
        }
        log.warn({ roundIndex }, 'context_overflow_compacted_retrying_round')
      }
    }
    const {
      didPause,
      didCompleteRest,
      sentTargets,
      inboxReads = [],
    } = interpretToolEffects(result.effects)

    stagedMessages.push(...result.messagesToAppend)
    const nextContinuity = parseMailboxContinuityState(mailboxContinuity)
    recordMailboxRound(nextContinuity, result.inputTokens)
    let nextInboxReadCursors = inboxReadCursors
    for (const read of inboxReads) {
      nextInboxReadCursors = advanceInboxReadCursor(
        nextInboxReadCursors,
        read.mailbox,
        read.throughRowId,
      )
    }
    await commitChanges({
      messages: stagedMessages,
      runtimePatch: {
        mailboxContinuity: nextContinuity,
        ...(inboxReads.length > 0 ? { inboxReadCursors: nextInboxReadCursors } : {}),
        ...(deps.getActiveToolCapabilities
          ? { activeToolCapabilities: [...deps.getActiveToolCapabilities()] }
          : {}),
        ...(deps.getQqConversationFocus
          ? { qqConversationFocus: deps.getQqConversationFocus() }
          : {}),
      },
    })
    const toolControl = resolveToolControl(result.toolOutcomes)
    return {
      inputTokens: result.inputTokens,
      contextWindowTokens: result.contextWindowTokens,
      providerPrefixHeadEntryId,
      tokensUsed: recoveryTokensUsed + result.tokensUsed,
      toolCallCount: result.toolCallCount,
      didPause,
      didCompleteRest,
      sentTargets,
      recoverableToolFailure: result.toolOutcomes.some((outcome) => (
        !outcome.ok && (
          outcome.retryClass === 'immediate'
          || (outcome.code != null && RECOVERABLE_TOOL_ERROR_CODES.has(outcome.code))
        )
      )),
      onlyHelpToolCalls: result.toolOutcomes.length > 0
        && result.toolOutcomes.every((outcome) => outcome.requestedToolName === 'help'),
      madeToolProgress: toolControl.madeProgress,
      evidenceMessageRowIds: [...new Set(result.toolOutcomes.flatMap(
        (outcome) => outcome.evidenceMessageRowIds ?? [],
      ))],
      toolOutcomes: result.toolOutcomes,
      ...(toolControl.continuation ? { toolContinuation: toolControl.continuation } : {}),
      ...(toolControl.continuationDetail
        ? { toolContinuationDetail: toolControl.continuationDetail }
        : {}),
    }
  }

  function resolveToolControl(outcomes: readonly ReactToolOutcome[]): {
    madeProgress: boolean
    continuation?: ToolContinuation
    continuationDetail?: string
  } {
    let madeProgress = false
    const continuations: Array<{
      continuation: ToolContinuation
      detail?: string
    }> = []
    for (const outcome of outcomes) {
      const duplicateNovelty = outcome.noveltyKey != null && recentToolNoveltyKeys.has(outcome.noveltyKey)
      if (outcome.noveltyKey != null) rememberToolNovelty(outcome.noveltyKey)
      if (duplicateNovelty) {
        log.info({
          toolName: outcome.toolName,
          noveltyKey: outcome.noveltyKey,
        }, 'tool_novelty_repeated_wait')
      } else if (outcome.progress) {
        madeProgress = true
      }
      if (outcome.continuation) {
        continuations.push({
          continuation: duplicateNovelty && outcome.continuation === 'immediate'
            ? 'wait_attention'
            : outcome.continuation,
          ...(outcome.continuationDetail
            ? { detail: outcome.continuationDetail.slice(0, 1_000) }
            : {}),
        })
      }
    }
    const selected = continuations.find(item => item.continuation === 'stop')
      ?? continuations.find(item => item.continuation === 'immediate')
      ?? continuations.find(item => item.continuation === 'backoff')
      ?? continuations.find(item => item.continuation === 'wait_event')
      ?? continuations.find(item => item.continuation === 'wait_attention')
    return {
      madeProgress,
      ...(selected ? { continuation: selected.continuation } : {}),
      ...(selected?.detail ? { continuationDetail: selected.detail } : {}),
    }
  }

  function rememberToolNovelty(key: string): void {
    recentToolNoveltyKeys.delete(key)
    recentToolNoveltyKeys.set(key, roundIndex)
    if (recentToolNoveltyKeys.size <= MAX_RECENT_TOOL_NOVELTY_KEYS) return
    const oldest = recentToolNoveltyKeys.keys().next().value as string | undefined
    if (oldest != null) recentToolNoveltyKeys.delete(oldest)
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

  async function maybeCompact(
    inputTokens: number | null,
    contextWindowTokens: number,
    providerPrefixHeadEntryId: bigint | null,
  ): Promise<boolean> {
    if (inputTokens == null) return false
    return compactCanonical({
      reason: 'threshold',
      contextTokens: inputTokens,
      contextWindowTokens,
      providerPrefixHeadEntryId,
    })
  }

  async function step(): Promise<{
    ranRound: boolean
    didPause?: boolean
    toolCallCount?: number
    actionRequired?: boolean
    recoverableToolFailure?: boolean
    onlyHelpToolCalls?: boolean
    madeToolProgress?: boolean
    shareCheckpointAppended?: boolean
    toolContinuation?: ToolContinuation
    toolContinuationDetail?: string
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
    const trigger = describeActivityTrigger(drained.events, goalAtRoundStart)
    deps.activityReporter?.setTrigger(trigger)
    deps.activityReporter?.setPhase({
      phase: 'thinking',
      roundIndex: roundIndex + 1,
      detail: goalAtRoundStart?.status === 'active'
        ? '正在推进当前持久 Goal'
        : '正在根据最新上下文决定下一步',
    })
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
    let disclosedInboxReadCursors = inboxReadCursors
    for (const [mailbox, throughRowId] of Object.entries(drained.cursors)) {
      if (throughRowId > (mailboxCursors[mailbox] ?? 0)) {
        disclosedInboxReadCursors = advanceInboxReadCursor(
          disclosedInboxReadCursors,
          mailbox,
          throughRowId,
        )
      }
    }
    if (stagedMessages.length > 0 || cursorsChanged || nextGoalRevision !== goalRevision) {
      try {
        await commitChanges({
          messages: stagedMessages,
          runtimePatch: {
            mailboxCursors: drained.cursors,
            ...(cursorsChanged ? { inboxReadCursors: disclosedInboxReadCursors } : {}),
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
      contextWindowTokens,
      providerPrefixHeadEntryId,
      tokensUsed,
      toolCallCount,
      didPause,
      didCompleteRest,
      sentTargets,
      recoverableToolFailure,
      onlyHelpToolCalls,
      madeToolProgress,
      evidenceMessageRowIds,
      toolOutcomes,
      toolContinuation,
      toolContinuationDetail,
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
      const directEvidenceIds = drained.events.flatMap((event) => (
        event.type === 'napcat_message' || event.type === 'napcat_private_message'
          ? [event.messageRowId]
          : []
      ))
      const allEvidenceIds = [...new Set([...directEvidenceIds, ...evidenceMessageRowIds])]
      await deps.lifeJournal?.recordRound({
        roundIndex,
        messages: roundMessages,
        ...(allEvidenceIds.length > 0 ? { evidenceMessageRowIds: allEvidenceIds } : {}),
      })
    } catch (err) {
      log.warn({ err, roundIndex }, 'life_journal_record_failed_skipped')
    }
    const restReminderNow = didCompleteRest ? autonomy.now() : null
    const shouldAppendRestReminder = restReminderNow != null
      && shouldAppendRestResumeReminder(deps.context.getSnapshot().messages, restReminderNow)
    const compacted = await maybeCompact(
      inputTokens,
      contextWindowTokens,
      providerPrefixHeadEntryId,
    )
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
    let shareCheckpointAppended = false
    if (!didPause && sentTargets.length === 0 && (deps.activeGroupShareTargets?.length ?? 0) > 0) {
      const checkpointNow = autonomy.now()
      let candidate = selectShareCheckpointCandidate(
        toolOutcomes,
        deps.context.getSnapshot().messages,
        checkpointNow,
      )
      if (candidate) {
        const canonical = await deps.ledgerRepo.loadCanonicalState()
        const permanentMessages = canonical.entries.flatMap((entry) => (
          entry.entryType === 'message' ? [entry.payload.message] : []
        ))
        candidate = selectShareCheckpointCandidate(toolOutcomes, permanentMessages, checkpointNow)
      }
      if (candidate) {
        await commitChanges({
          messages: [{
            role: 'user',
            content: renderShareCheckpoint(candidate, deps.activeGroupShareTargets!, checkpointNow),
          }],
        })
        shareCheckpointAppended = true
        log.info({
          candidateKey: candidate.key,
          sourceTool: candidate.sourceTool,
          activeGroupCount: deps.activeGroupShareTargets!.length,
        }, 'share_checkpoint_appended')
      }
    }
    return {
      ranRound: true,
      didPause,
      toolCallCount,
      recoverableToolFailure,
      onlyHelpToolCalls,
      madeToolProgress,
      shareCheckpointAppended,
      ...(toolContinuation ? { toolContinuation } : {}),
      ...(toolContinuationDetail ? { toolContinuationDetail } : {}),
      actionRequired: goalAtRoundStart?.status === 'active'
        || (drained.hadAttention && disclosed > 0)
        || hasPendingPrivateMailboxAttention(deps.context.getSnapshot().messages),
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
      madeToolProgress = false,
      shareCheckpointAppended = false,
      toolContinuation,
      toolContinuationDetail,
    } = await step()
    if (!ranRound && !stopRequested) {
      await waitForExternalEvent()
      return
    }
    if (!ranRound || stopRequested) return

    if (didPause) {
      consecutiveRounds = 0
      actionCorrectionRetryPending = false
      recoverableToolCorrectionRounds = 0
      idleBackoffLevel = 0
      return
    }

    consecutiveRounds++

    if (toolCallCount > 0) {
      const continuingCorrection = recoverableToolFailure
        || (recoverableToolCorrectionRounds > 0 && onlyHelpToolCalls)
      if (
        continuingCorrection
        && recoverableToolCorrectionRounds < MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS
      ) {
        recoverableToolCorrectionRounds++
        actionCorrectionRetryPending = false
        idleBackoffLevel = 0
        log.info({
          consecutiveRounds,
          correctionRound: recoverableToolCorrectionRounds,
          maxCorrectionRounds: MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS,
          recoverableToolFailure,
          onlyHelpToolCalls,
        }, 'recoverable_tool_error_retry_immediate')
        return
      }
      if (!recoverableToolFailure && !onlyHelpToolCalls) recoverableToolCorrectionRounds = 0
      if (shareCheckpointAppended) {
        actionCorrectionRetryPending = false
        idleBackoffLevel = 0
        return
      }
      if (toolContinuation === 'immediate') {
        idleBackoffLevel = 0
        return
      }
      if (toolContinuation === 'stop') {
        const waitMs = currentIdleWaitMs()
        log.info({ consecutiveRounds, waitMs }, 'tool_requested_stop_wait')
        const wake = await waitForAttention(
          toolContinuationDetail ?? '工具请求停止，等待新的注意事件',
          waitMs,
        )
        actionCorrectionRetryPending = false
        updateIdleBackoff(wake, true)
        return
      }
      if (toolContinuation === 'wait_event') {
        await waitForToolExternalEvent(toolContinuationDetail, actionRequired)
        return
      }
      if (toolContinuation === 'backoff' || toolContinuation === 'wait_attention') {
        if (actionRequired) idleBackoffLevel = 0
        const waitMs = actionRequired ? autonomy.actionRetryWaitMs : currentIdleWaitMs()
        log.info({
          consecutiveRounds,
          waitMs,
          actionRequired,
          toolContinuation,
          idleBackoffLevel,
        }, 'tool_continuation_wait')
        const wake = await waitForAttention(
          toolContinuationDetail
            ?? (actionRequired ? '当前行动需要稍后重试' : '等待新的注意事件或退避到期'),
          waitMs,
        )
        actionCorrectionRetryPending = false
        updateIdleBackoff(wake, !actionRequired)
        return
      }
      if (madeToolProgress) {
        actionCorrectionRetryPending = false
        idleBackoffLevel = 0
        return
      }
      if (!madeToolProgress) {
        if (actionRequired) idleBackoffLevel = 0
        if (actionRequired && !actionCorrectionRetryPending) {
          actionCorrectionRetryPending = true
          log.info({ consecutiveRounds }, 'tool_no_progress_action_retry_immediate')
          return
        }
        const waitMs = actionRequired ? autonomy.actionRetryWaitMs : currentIdleWaitMs()
        log.info({ consecutiveRounds, waitMs, actionRequired, idleBackoffLevel }, 'tool_no_progress_wait')
        const wake = await waitForAttention(
          actionRequired ? '工具没有取得进展，等待短暂重试' : '当前没有新进展，等待新的注意事件',
          waitMs,
        )
        actionCorrectionRetryPending = false
        updateIdleBackoff(wake, !actionRequired)
        return
      }
    }

    if (actionRequired || actionCorrectionRetryPending) {
      idleBackoffLevel = 0
      if (!actionCorrectionRetryPending) {
        actionCorrectionRetryPending = true
        log.info({ consecutiveRounds }, 'no_tool_action_retry_immediate')
        return
      }
      log.info(
        { consecutiveRounds, waitMs: autonomy.actionRetryWaitMs },
        'no_tool_action_retry_wait',
      )
      await waitForAttention('当前请求尚未完成，等待短暂重试', autonomy.actionRetryWaitMs)
      actionCorrectionRetryPending = false
      return
    }

    const waitMs = currentIdleWaitMs()
    log.info({ consecutiveRounds, waitMs, idleBackoffLevel, actionAnchor: 'none' }, 'no_tool_quiescent_wait')
    const wake = await waitForAttention('当前没有待处理行动，等待新消息或计划事件', waitMs)
    updateIdleBackoff(wake, true)
    consecutiveRounds = 0
    recoverableToolCorrectionRounds = 0
  }

  async function waitForToolExternalEvent(
    detail: string | undefined,
    actionRequired: boolean,
  ): Promise<void> {
    const waitMs = currentIdleWaitMs()
    log.info({
      consecutiveRounds,
      waitMs,
      actionRequired,
      toolContinuation: 'wait_event',
    }, 'tool_external_event_wait')
    await waitForAttention(
      detail ?? '后台工作仍在运行，等待完成事件',
      waitMs,
    )
    consecutiveRounds = 0
    actionCorrectionRetryPending = false
    recoverableToolCorrectionRounds = 0
    idleBackoffLevel = 0
  }

  function currentIdleWaitMs(): number {
    return Math.min(
      autonomy.maxIdleWaitMs,
      autonomy.idleWaitMs * (2 ** Math.min(idleBackoffLevel, 20)),
    )
  }

  async function waitForAttention(
    detail: string,
    timeoutMs: number,
  ): Promise<'attention' | 'elapsed'> {
    deps.activityReporter?.setPhase({
      phase: 'waiting',
      detail,
      waitUntil: new Date(autonomy.now().getTime() + timeoutMs).toISOString(),
    })
    return await autonomy.waitForAttentionOrTimeout(deps.eventQueue, timeoutMs)
  }

  function updateIdleBackoff(wake: 'attention' | 'elapsed', unanchored: boolean): void {
    if (wake === 'attention' || !unanchored) {
      idleBackoffLevel = 0
      return
    }
    idleBackoffLevel = Math.min(idleBackoffLevel + 1, 20)
  }

  async function waitForExternalEvent(): Promise<void> {
    deps.activityReporter?.setPhase({
      phase: 'waiting',
      detail: '上下文为空，等待第一条消息或计划事件',
      waitUntil: null,
    })
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
        deps.activityReporter?.setPhase({
          phase: 'error',
          roundIndex,
          detail: err instanceof Error ? err.message.slice(0, 1_000) : String(err).slice(0, 1_000),
          waitUntil: new Date(autonomy.now().getTime() + (deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS)).toISOString(),
        })
        await sleep(deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS)
      }
    }
  }

  return {
    async start() {
      stopRequested = false
      if (compactionAbortController.signal.aborted) {
        compactionAbortController = new AbortController()
      }
      deps.activityReporter?.setPhase({ phase: 'starting', roundIndex: null, detail: '主循环正在启动' })
      log.info('bot_loop_started')
      try {
        await loop()
      } finally {
        deps.activityReporter?.setPhase({ phase: 'stopped', detail: '主循环已停止', waitUntil: null })
        await deps.activityReporter?.flush()
      }
    },
    async stop() {
      stopRequested = true
      deps.activityReporter?.setPhase({ phase: 'stopping', detail: '正在安全停止主循环', waitUntil: null })
      compactionAbortController.abort(new Error('bot loop stopping'))
      cancelDebounceSleep?.()
      deps.eventQueue.enqueue({ type: 'wake' })
      log.info('bot_loop_stop_requested')
    },
    async flush() {
      await syncGoalState()
      await deps.activityReporter?.flush()
    },
    async requestManualCompaction(focus) {
      const canonical = await deps.ledgerRepo.loadCanonicalState()
      return compactCanonical({
        reason: 'manual',
        contextTokens: estimateLedgerContextTokens({ entries: canonical.entries }).tokens,
        contextWindowTokens: lastContextWindowTokens,
        ...(focus == null ? {} : { manualFocus: focus }),
      })
    },
    async runOnceForTest() {
      await step()
    },
  }
}

function describeActivityTrigger(
  events: readonly BotEvent[],
  goal: AgentGoal | null,
): AgentActivityTrigger | null {
  for (const event of events) {
    if (event.type === 'napcat_private_message') {
      return {
        kind: 'private_message',
        label: `收到 ${event.senderNickname || event.peerId} 的私聊`,
        target: { type: 'private', id: String(event.peerId) },
      }
    }
    if (event.type === 'napcat_message' && event.mentionedSelf) {
      return {
        kind: 'group_mention',
        label: `群 ${event.groupName || event.groupId} 中有人提到了 Agent`,
        target: { type: 'group', id: String(event.groupId) },
      }
    }
    if (event.type === 'scheduled_wake') {
      return {
        kind: 'scheduled_wake',
        label: `计划“${event.name}”到期：${event.intention}`.slice(0, 500),
        target: null,
      }
    }
    if (event.type === 'background_task_completed') {
      return {
        kind: 'background_task',
        label: `后台任务 ${event.toolName} 已${event.ok ? '完成' : '失败'}：${event.description}`.slice(0, 500),
        target: null,
      }
    }
    if (event.type === 'mailbox_backlog') {
      return event.source.type === 'group'
        ? {
            kind: 'group_mention',
            label: `恢复了群 ${event.source.groupName || event.source.groupId} 的 ${event.count} 条待处理通知`,
            target: { type: 'group', id: String(event.source.groupId) },
          }
        : {
            kind: 'private_message',
            label: `恢复了 ${event.source.senderName} 的 ${event.count} 条待处理私聊`,
            target: { type: 'private', id: String(event.source.peerId) },
          }
    }
    if (event.type === 'bootstrap') {
      return { kind: 'bootstrap', label: '首次启动，开始建立自己的初始方向', target: null }
    }
    if (event.type === 'curiosity_tick' || event.type === 'wake') {
      return { kind: 'manual_wake', label: '收到运行时唤醒信号', target: null }
    }
  }
  if (goal?.status === 'active') {
    return { kind: 'goal', label: `继续推进 Goal：${goal.objective}`.slice(0, 500), target: null }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveOverflowContextWindowTokens(error: unknown, fallback: number): number {
  if (error && typeof error === 'object' && 'contextWindowTokens' in error) {
    const value = error.contextWindowTokens
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return fallback
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
