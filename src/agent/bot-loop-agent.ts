import type { AgentContext } from './agent-context.js'
import type { AgentMessage, ConversationFocus } from './agent-context.types.js'
import { conversationKey } from '../chat/conversation.js'
import { isLlmContextOverflowError, type LlmClient } from './llm-client.js'
import type { MessageSentTarget, ToolContinuation, ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { AgentLedgerLoader } from './agent-ledger-loader.js'
import { type AgentLedgerRepo, type AgentRuntimePatch } from './agent-ledger-repo.js'
import type { MaybeCompactOptions } from './compaction.js'
import {
  LlmOutputTruncatedError,
  resolveEffectiveToolName,
  runReactRound,
  type ReactToolOutcome,
} from './react-kernel.js'
import { interpretToolEffects } from './effect-interpreter.js'
import { createLogger } from '../logger.js'
import {
  isHighPriorityMailboxDisclosure,
  planMailboxDisclosures,
  renderMailboxBacklogNotification,
  renderMailboxNotification,
  type MailboxDisclosure,
  type MailboxCursors,
} from './mailbox.js'
import {
  decideMailboxCompensation,
  parseMailboxContinuityState,
  recordMailboxDisclosure,
  recordMailboxRound,
  type MailboxContinuityState,
} from './mailbox-continuity.js'
import {
  findPendingMailboxThroughRowId,
  hasPendingMailboxAttention,
  renderMailboxHandledEvent,
} from './mailbox-handled.js'
import { config } from '../config/index.js'
import type { GroupParticipation } from '../config/group-policies.js'
import {
  advanceInboxReadCursor,
  type InboxReadCursors,
} from './inbox-read-cursors.js'
import type { AgentActivityReporter } from './activity-surface.js'
import { describeActivityTrigger } from './activity-trigger.js'
import {
  isAttentionEvent,
  notificationRoutingForEvent,
} from './notification.js'
import { createLedgerCommitCoordinator } from './ledger-commit-coordinator.js'
import { decideLoopPolicy, type LoopDemand } from './loop-policy.js'
import { createCompactionCoordinator } from './compaction-coordinator.js'

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
  initialLedgerHeadEntryId?: bigint | null
  /** 跨平台会话焦点也是 runtime control state，与可见 tool result 同事务落盘。 */
  getConversationFocus?: () => ConversationFocus
  syncConversationFocus?: (focus: ConversationFocus) => void
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
  /** 可丢弃的实时活动观察面；不进入 ledger/runtime singleton。 */
  activityReporter?: AgentActivityReporter
  /** 事件对应的 user message 已进入 canonical ledger 后触发。 */
  onEventsCommitted?: (events: readonly BotEvent[]) => Promise<void> | void
}

export interface BotLoopAutonomyOptions {
  actionRetryWaitMs?: number
  wakeIntervalMs?: number
  now?: () => Date
  waitForAttentionOrTimeout?: (
    queue: EventQueue<BotEvent>,
    timeoutMs: number,
  ) => Promise<'attention' | 'elapsed'>
  waitForEventOrTimeout?: (
    queue: EventQueue<BotEvent>,
    timeoutMs: number,
  ) => Promise<'event' | 'elapsed'>
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000
const DEFAULT_EVENT_DEBOUNCE_MS = 3_000
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 86_400_000
const DEFAULT_ACTION_RETRY_WAIT_MS = 60_000
const DEFAULT_AUTONOMY_WAKE_INTERVAL_MS = 30 * 60_000
const DEFAULT_COMPACTION_FAILURE_BACKOFF_MS = 10 * 60_000
const MAX_OUTPUT_CONTINUATIONS_PER_ROUND = 2
const MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS = 3
const MAX_NO_PROGRESS_ROUNDS = 2
const MAX_RECENT_TOOL_NOVELTY_KEYS = 256
const AUTONOMY_MAINTENANCE_TOOL_NAMES = new Set([
  'clock',
  'conversation',
  'help',
  'memory',
  'notebook',
  'psychologist',
  'schedule',
  'send_message',
  'skill',
])
const AUTONOMY_DISCOVERY_DIRECTIONS = [
  {
    id: 'unfinished_commitments',
    instruction: '检查最近上下文里已经承诺、开始但尚未验证完成的事情；只选择一个仍可执行的具体缺口。',
  },
  {
    id: 'existing_artifacts',
    instruction: '检查已有 Notebook、工作文件、作品或后台结果；优先改进一个已有对象，不要批量新建相似内容。',
  },
  {
    id: 'bounded_curiosity',
    instruction: '从当前已授权能力里选择一个具体问题做一次有界探索；必须能获得新证据或改变可观察状态。',
  },
] as const
const OUTPUT_CONTINUATION_PROMPT =
  '[runtime recovery] 上一段 assistant 输出达到长度上限。请从中断处继续，不要重复已完成内容，并用一个完整的工具调用结束本轮。'
const ASSISTANT_TEXT_ONLY_CORRECTION = JSON.stringify({
  event: 'runtime_correction',
  code: 'assistant_text_without_tool',
  instruction: '上一轮只输出了普通 assistant 文本；它不会发送给任何人，也不会执行其中的计划。现在调用一个具体工具：有明确牵引力就推进、修改或向一个相关对象问具体反馈；换题但重复同一种批量生产也算机械重复。当前方向已完成后只做一次有界方向搜索，没有真正想做的事时直接调用 rest，并选择一次足够且诚实的休息时长。',
})
const ATTENTION_REQUIRED_CORRECTION = JSON.stringify({
  event: 'runtime_correction',
  code: 'attention_pending',
  instruction: '仍有未处理的高优先级私聊。暂停当前方向，先按 notification.open 读取并回应；处理后再回到原方向。',
})
const CONTINUOUS_AUTONOMY_BOOTSTRAP = JSON.stringify({
  event: 'runtime_bootstrap',
  code: 'continuous_autonomy_started',
  instruction: '现在开始自主生活。有明确牵引力时持续行动；作品和判断可以继续修改、分享一个具体问题并在反馈后复盘，不把新建产出当成唯一进展。当前方向完成后只做一次有界方向搜索，有真正想做、值得做的下一步就用真实工具开始。候选都没有吸引力、只是在证明忙碌或已经机械重复时，不要强行制造工作，直接调用 rest 真正闲下来。',
})
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
    actionRetryWaitMs: Math.max(1, deps.autonomy?.actionRetryWaitMs ?? DEFAULT_ACTION_RETRY_WAIT_MS),
    wakeIntervalMs: Math.max(1, deps.autonomy?.wakeIntervalMs ?? DEFAULT_AUTONOMY_WAKE_INTERVAL_MS),
    now: deps.autonomy?.now ?? (() => new Date()),
    waitForAttentionOrTimeout: deps.autonomy?.waitForAttentionOrTimeout ?? waitForAttentionOrTimeout,
    waitForEventOrTimeout: deps.autonomy?.waitForEventOrTimeout ?? waitForEventOrTimeout,
  }
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  let inboxReadCursors: InboxReadCursors = { ...deps.initialInboxReadCursors }
  let mailboxContinuity = parseMailboxContinuityState(deps.initialMailboxContinuity)
  let ledgerHeadEntryId = deps.initialLedgerHeadEntryId ?? null
  let roundIndex = 0
  let consecutiveRounds = 0
  let attentionCorrectionIssued = false
  let assistantTextOnlyCorrectionIssued = false
  let shortWorkContinuationPending = false
  let recoverableToolCorrectionRounds = 0
  let noProgressRounds = 0
  let autonomyDiscoveryActive = false
  let autonomyDiscoveryPromptPending = false
  let autonomyDiscoverySource: 'idle_timeout' | 'rest_elapsed' = 'idle_timeout'
  let autonomyDiscoveryDirectionIndex = 0
  let failedAutonomyDirections = 0
  let autonomyDiscoveryDirection: (typeof AUTONOMY_DISCOVERY_DIRECTIONS)[number] =
    AUTONOMY_DISCOVERY_DIRECTIONS[0]
  const recentToolNoveltyKeys = new Map<string, number>()
  const autonomyDiscoveryTools = createAutonomyDiscoveryToolExecutor(deps.tools)
  let lastContextWindowTokens =
    config.llm.contextWindowTokensByModel[config.llm.defaultModel] ?? 200_000

  function beginAutonomyDiscovery(source: 'idle_timeout' | 'rest_elapsed'): void {
    autonomyDiscoveryActive = true
    autonomyDiscoveryPromptPending = true
    autonomyDiscoverySource = source
    autonomyDiscoveryDirection = AUTONOMY_DISCOVERY_DIRECTIONS[
      autonomyDiscoveryDirectionIndex % AUTONOMY_DISCOVERY_DIRECTIONS.length
    ]!
    autonomyDiscoveryDirectionIndex++
    noProgressRounds = 0
    assistantTextOnlyCorrectionIssued = false
  }

  function endAutonomyDiscovery(): void {
    autonomyDiscoveryActive = false
    autonomyDiscoveryPromptPending = false
  }

  function renderAutonomyDiscoveryPrompt(): string {
    return JSON.stringify({
      event: 'runtime_autonomy_tick',
      source: autonomyDiscoverySource,
      code: 'autonomy_discovery_required',
      direction: autonomyDiscoveryDirection,
      instruction: '这是 runtime 定时主动唤醒，不是外部新任务。现在完成一次有界方向搜索：先按 direction 检查，再选择一个能产生新证据或改变可观察状态的具体行动。探索期间 rest 不可用；不要用 close、重复读取、重复 Schedule 或改写理由证明忙碌。找到真实方向就立即推进；连续两轮仍无进展时 runtime 会重新等待下一次唤醒。',
    })
  }

  function installRuntimeState(input: {
    mailboxCursors: MailboxCursors
    inboxReadCursors: InboxReadCursors
    mailboxContinuity: MailboxContinuityState
    conversationFocus: ConversationFocus
    lastWakeAt: Date | null
    ledgerHeadEntryId: bigint | null
  }): void {
    mailboxCursors = { ...input.mailboxCursors }
    inboxReadCursors = { ...input.inboxReadCursors }
    mailboxContinuity = parseMailboxContinuityState(input.mailboxContinuity)
    lastWakeAt = input.lastWakeAt == null ? null : new Date(input.lastWakeAt)
    ledgerHeadEntryId = input.ledgerHeadEntryId
    deps.syncConversationFocus?.(input.conversationFocus)
    deps.syncInboxReadCursors?.(input.inboxReadCursors)
  }

  async function reloadProjectionFromCanonical(): Promise<void> {
    const loaded = await deps.ledgerLoader.load()
    deps.context.installProjection(loaded.projection.snapshot)
    installRuntimeState(loaded.runtimeState)
  }

  const commitCoordinator = createLedgerCommitCoordinator({
    context: deps.context,
    repo: deps.ledgerRepo,
    getExpectedHeadEntryId: () => ledgerHeadEntryId,
    installRuntimeState,
  })

  async function commitChanges(input: {
    messages?: readonly AgentMessage[]
    runtimePatch?: AgentRuntimePatch
  }): Promise<void> {
    const messages = input.messages ?? []
    if (messages.length === 0 && input.runtimePatch == null) return

    try {
      await commitCoordinator.commit({ messages, ...(input.runtimePatch ? { runtimePatch: input.runtimePatch } : {}) })
    } catch (error) {
      deps.syncConversationFocus?.(deps.context.getSnapshot().conversationFocus)
      deps.syncInboxReadCursors?.(inboxReadCursors)
      throw error
    }
  }

  const compactionCoordinator = createCompactionCoordinator({
    context: deps.context,
    repo: deps.ledgerRepo,
    llm: deps.llm,
    tools: deps.tools,
    systemPrompt: deps.systemPrompt,
    options: deps.compactOptions,
    defaultReserveTokens: config.compaction.reserveTokens,
    defaultKeepRecentTokens: config.compaction.keepRecentTokens,
    defaultFailureBackoffMs: DEFAULT_COMPACTION_FAILURE_BACKOFF_MS,
    installRuntimeState,
    reloadProjectionFromCanonical,
  })

  function drainEvents(): {
    consumed: number
    hadAttention: boolean
    interrupting: MailboxDisclosure[]
    passive: MailboxDisclosure[]
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
      interrupting: [...highInterruptingDisclosures, ...normalInterruptingDisclosures],
      passive: ordinaryDisclosures,
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
        const groupId = disclosure.event.source.type === 'group'
          ? disclosure.event.source.groupId
          : disclosure.event.source.type === 'conversation'
            && disclosure.event.source.conversation.platform === 'qq'
            && disclosure.event.source.conversation.kind === 'group'
            ? Number(disclosure.event.source.conversation.externalId)
            : null
        const participation = groupId != null && Number.isSafeInteger(groupId)
          ? deps.groupParticipations?.get(groupId)
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
        const groupId = firstEvent.type === 'napcat_message'
          ? firstEvent.groupId
          : firstEvent.type === 'chat_message'
            && firstEvent.conversation.platform === 'qq'
            && firstEvent.conversation.kind === 'group'
            ? Number(firstEvent.conversation.externalId)
            : null
        const participation = groupId != null && Number.isSafeInteger(groupId)
          ? deps.groupParticipations?.get(groupId)
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

  async function runRound(tools: ToolExecutor): Promise<{
    inputTokens: number | null
    contextWindowTokens: number
    providerPrefixHeadEntryId: bigint | null
    toolCallCount: number
    sentTargets: MessageSentTarget[]
    workContinuationRequested: boolean
    recoverableToolFailure: boolean
    onlyHelpToolCalls: boolean
    madeToolProgress: boolean
    assistantTextOnly: boolean
    assistantTextOnlyCorrectionAppended: boolean
    restElapsed: boolean
    toolContinuation?: ToolContinuation
    toolContinuationDetail?: string
  }> {
    roundIndex++
    let recoveredContextOverflow = false
    let outputContinuations = 0
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
          tools,
          toolContext: {
            eventQueue: deps.eventQueue,
            roundIndex,
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
        const compacted = await compactionCoordinator.compact({
          reason: 'overflow',
          contextTokens: overflowContextWindow,
          contextWindowTokens: overflowContextWindow,
        })
        if (!compacted) throw err
        log.warn({ roundIndex }, 'context_overflow_compacted_retrying_round')
      }
    }
    const {
      sentTargets,
      inboxReads = [],
      workContinuationRequested = false,
    } = interpretToolEffects(result.effects)

    stagedMessages.push(...result.messagesToAppend)
    const assistantTextOnlyCorrectionAppended =
      result.assistantTextOnly && !assistantTextOnlyCorrectionIssued
    if (assistantTextOnlyCorrectionAppended) {
      stagedMessages.push({ role: 'user', content: ASSISTANT_TEXT_ONLY_CORRECTION })
    }
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
        ...(deps.getConversationFocus
          ? { conversationFocus: deps.getConversationFocus() }
          : {}),
      },
    })
    const toolControl = resolveToolControl(result.toolOutcomes)
    return {
      inputTokens: result.inputTokens,
      contextWindowTokens: result.contextWindowTokens,
      providerPrefixHeadEntryId,
      toolCallCount: result.toolCallCount,
      sentTargets,
      workContinuationRequested,
      recoverableToolFailure: result.toolOutcomes.some((outcome) => (
        !outcome.ok && outcome.continuation === 'immediate'
      )),
      onlyHelpToolCalls: result.toolOutcomes.length > 0
        && result.toolOutcomes.every((outcome) => outcome.requestedToolName === 'help'),
      madeToolProgress: toolControl.madeProgress,
      assistantTextOnly: result.assistantTextOnly,
      assistantTextOnlyCorrectionAppended,
      restElapsed: result.toolOutcomes.some((outcome) => (
        outcome.toolName === 'rest' && outcome.code === 'rest_elapsed'
      )),
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
      const canonicalMailbox = conversationKey(target)
      const legacyMailbox = target.platform === 'qq'
        ? `qq_${target.kind}:${target.externalId}`
        : null
      const mailbox = findPendingMailboxThroughRowId(messages, canonicalMailbox) != null
        ? canonicalMailbox
        : legacyMailbox
          && findPendingMailboxThroughRowId(messages, legacyMailbox) != null
          ? legacyMailbox
          : canonicalMailbox
      if (seenMailboxes.has(mailbox)) continue
      seenMailboxes.add(mailbox)

      const throughRowId = findPendingMailboxThroughRowId(messages, mailbox)
      if (throughRowId == null) continue
      markers.push({ role: 'user', content: renderMailboxHandledEvent(mailbox, throughRowId) })
    }
    return markers
  }

  async function maybeCompact(
    inputTokens: number | null,
    contextWindowTokens: number,
    providerPrefixHeadEntryId: bigint | null,
  ): Promise<boolean> {
    if (inputTokens == null) return false
    return compactionCoordinator.compact({
      reason: 'threshold',
      contextTokens: inputTokens,
      contextWindowTokens,
      providerPrefixHeadEntryId,
    })
  }

  async function step(): Promise<{
    ranRound: boolean
    toolCallCount?: number
    demand?: LoopDemand
    recoverableToolFailure?: boolean
    onlyHelpToolCalls?: boolean
    madeToolProgress?: boolean
    assistantTextOnly?: boolean
    assistantTextOnlyCorrectionAppended?: boolean
    restElapsed?: boolean
    autonomyDiscoveryRound?: boolean
    toolContinuation?: ToolContinuation
    toolContinuationDetail?: string
  }> {
    const stagedMessages: AgentMessage[] = []
    const stagedContinuity = parseMailboxContinuityState(mailboxContinuity)
    const stagedWake = { lastWakeAt }
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
    if (drained.events.length > 0) {
      endAutonomyDiscovery()
      failedAutonomyDirections = 0
      noProgressRounds = 0
      assistantTextOnlyCorrectionIssued = false
    }
    const trigger = describeActivityTrigger(drained.events)
    deps.activityReporter?.setTrigger(trigger)
    deps.activityReporter?.setPhase({
      phase: 'thinking',
      roundIndex: roundIndex + 1,
      detail: '正在根据最新上下文决定下一步',
    })
    let disclosed = await discloseEvents(
      drained.interrupting,
      stagedMessages,
      stagedContinuity,
      stagedWake,
    )
    disclosed += await discloseEvents(
      drained.passive,
      stagedMessages,
      stagedContinuity,
      stagedWake,
    )
    if (
      !stopRequested
      && deps.context.getSnapshot().messages.length === 0
      && stagedMessages.length === 0
    ) {
      stagedMessages.push({ role: 'user', content: CONTINUOUS_AUTONOMY_BOOTSTRAP })
    }
    let autonomyDiscoveryAppended = false
    if (
      !stopRequested
      && autonomyDiscoveryActive
      && autonomyDiscoveryPromptPending
      && drained.events.length === 0
    ) {
      stagedMessages.push({ role: 'user', content: renderAutonomyDiscoveryPrompt() })
      autonomyDiscoveryPromptPending = false
      autonomyDiscoveryAppended = true
    }
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: drained.consumed, eventsDisclosed: disclosed }, 'round_start')

    const cursorsChanged = JSON.stringify(drained.cursors) !== JSON.stringify(mailboxCursors)
    let eventsCommitted = false
    if (stagedMessages.length > 0 || cursorsChanged) {
      try {
        await commitChanges({
          messages: stagedMessages,
          runtimePatch: {
            mailboxCursors: drained.cursors,
            mailboxContinuity: stagedContinuity,
            lastWakeAt: stagedWake.lastWakeAt,
          },
        })
        eventsCommitted = true
      } catch (error) {
        if (autonomyDiscoveryAppended) autonomyDiscoveryPromptPending = true
        for (const event of drained.events) deps.eventQueue.enqueue(event)
        throw error
      }
    }
    if (eventsCommitted && drained.events.length > 0) {
      try {
        await deps.onEventsCommitted?.(drained.events)
      } catch (error) {
        log.warn({ error }, 'event_commit_notification_failed')
      }
    }

    if (deps.context.getSnapshot().messages.length === 0) {
      return { ranRound: false }
    }

    const shortWorkContinuationAtRoundStart = shortWorkContinuationPending
    const autonomyDiscoveryAtRoundStart = autonomyDiscoveryActive
    const roundResult = await runRound(
      autonomyDiscoveryAtRoundStart ? autonomyDiscoveryTools : deps.tools,
    )
    const {
      inputTokens,
      contextWindowTokens,
      providerPrefixHeadEntryId,
      toolCallCount,
      sentTargets,
      workContinuationRequested,
      recoverableToolFailure,
      onlyHelpToolCalls,
      madeToolProgress,
      assistantTextOnly,
      assistantTextOnlyCorrectionAppended,
      restElapsed,
      toolContinuation,
      toolContinuationDetail,
    } = roundResult
    const handledMailboxMarkers = collectHandledMailboxMarkers(sentTargets)
    await commitChanges({ messages: handledMailboxMarkers })
    await maybeCompact(
      inputTokens,
      contextWindowTokens,
      providerPrefixHeadEntryId,
    )
    shortWorkContinuationPending = workContinuationRequested
    const attentionPending = hasPendingMailboxAttention(
      deps.context.getSnapshot().messages,
      inboxReadCursors,
    )
    if (assistantTextOnly) {
      assistantTextOnlyCorrectionIssued = assistantTextOnlyCorrectionAppended
        || assistantTextOnlyCorrectionIssued
    } else {
      assistantTextOnlyCorrectionIssued = false
    }
    const continuationRequired = (drained.hadAttention && disclosed > 0)
      || assistantTextOnlyCorrectionAppended
      || shortWorkContinuationAtRoundStart
      || workContinuationRequested
    return {
      ranRound: true,
      toolCallCount,
      recoverableToolFailure,
      onlyHelpToolCalls,
      madeToolProgress,
      assistantTextOnly,
      assistantTextOnlyCorrectionAppended,
      restElapsed,
      autonomyDiscoveryRound: autonomyDiscoveryAtRoundStart,
      ...(toolContinuation ? { toolContinuation } : {}),
      ...(toolContinuationDetail ? { toolContinuationDetail } : {}),
      demand: attentionPending ? 'attention' : continuationRequired ? 'continuation' : 'none',
    }
  }

  async function runOnce(): Promise<void> {
    const {
      ranRound,
      toolCallCount = 0,
      demand = 'none',
      recoverableToolFailure = false,
      onlyHelpToolCalls = false,
      madeToolProgress = false,
      assistantTextOnly = false,
      assistantTextOnlyCorrectionAppended = false,
      restElapsed = false,
      autonomyDiscoveryRound = false,
      toolContinuation,
      toolContinuationDetail,
    } = await step()
    if (ranRound) {
      consecutiveRounds++
    }
    const decision = decideLoopPolicy({
      ranRound,
      stopRequested,
      toolCallCount,
      demand,
      recoverableToolFailure,
      onlyHelpToolCalls,
      madeToolProgress: madeToolProgress || restElapsed,
      ...(toolContinuation ? { toolContinuation } : {}),
      recoverableCorrectionRounds: recoverableToolCorrectionRounds,
      maxRecoverableCorrectionRounds: MAX_RECOVERABLE_TOOL_CORRECTION_ROUNDS,
      noProgressRounds,
      maxNoProgressRounds: MAX_NO_PROGRESS_ROUNDS,
    })
    recoverableToolCorrectionRounds = decision.recoverableCorrectionRounds
    noProgressRounds = decision.noProgressRounds
    if (demand !== 'attention') attentionCorrectionIssued = false
    if (restElapsed) {
      beginAutonomyDiscovery('rest_elapsed')
    } else if (autonomyDiscoveryRound && madeToolProgress) {
      failedAutonomyDirections = 0
      endAutonomyDiscovery()
    } else if (!autonomyDiscoveryRound && madeToolProgress) {
      failedAutonomyDirections = 0
    }
    if (
      autonomyDiscoveryRound
      && decision.action === 'wait_event'
      && decision.reason === 'no_progress_limit'
    ) {
      failedAutonomyDirections++
      if (failedAutonomyDirections >= AUTONOMY_DISCOVERY_DIRECTIONS.length) {
        const compacted = await compactionCoordinator.compact({
          reason: 'behavioral_reset',
          contextWindowTokens: lastContextWindowTokens,
        })
        if (compacted) {
          log.info({ failedAutonomyDirections }, 'autonomy_behavioral_reset_committed')
          failedAutonomyDirections = 0
        } else {
          log.warn({ failedAutonomyDirections }, 'autonomy_behavioral_reset_skipped')
        }
      }
    }

    if (decision.action === 'stop') return
    if (decision.action === 'wait_event') {
      endAutonomyDiscovery()
      await waitForExternalEvent()
      return
    }
    if (decision.action === 'continue') {
      if (decision.reason === 'attention_pending' && !attentionCorrectionIssued) {
        await commitChanges({
          messages: [{ role: 'user', content: ATTENTION_REQUIRED_CORRECTION }],
        })
        attentionCorrectionIssued = true
      }
      log.info({
        consecutiveRounds,
        reason: decision.reason,
        correctionRound: recoverableToolCorrectionRounds,
        assistantTextOnly,
        assistantTextOnlyCorrectionAppended,
      }, 'loop_policy_continue')
      return
    }

    const waitMs = autonomy.actionRetryWaitMs
    const detail = toolContinuationDetail ?? '外部能力要求短暂退避，等待后重试或切换方向'
    log.info({
      consecutiveRounds,
      waitMs,
      actionRequired: demand !== 'none',
      reason: decision.reason,
    }, 'loop_policy_wait')
    await waitForAttention(detail, waitMs)
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

  async function waitForExternalEvent(): Promise<void> {
    const timeoutMs = autonomy.wakeIntervalMs
    deps.activityReporter?.setPhase({
      phase: 'waiting',
      detail: '当前方向已结束，等待外部事件或下一次自主探索',
      waitUntil: new Date(autonomy.now().getTime() + timeoutMs).toISOString(),
    })
    const keepAlive = (deps.keepAlive ?? defaultKeepAlive).open()
    try {
      consecutiveRounds = 0
      const result = await autonomy.waitForEventOrTimeout(deps.eventQueue, timeoutMs)
      if (result === 'elapsed' && !stopRequested) beginAutonomyDiscovery('idle_timeout')
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
      compactionCoordinator.start()
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
      compactionCoordinator.stop()
      cancelDebounceSleep?.()
      deps.eventQueue.enqueue({ type: 'wake' })
      log.info('bot_loop_stop_requested')
    },
    async flush() {
      await deps.activityReporter?.flush()
    },
    async runOnceForTest() {
      await step()
    },
  }
}

function createAutonomyDiscoveryToolExecutor(tools: ToolExecutor): ToolExecutor {
  return {
    list: () => tools.list(),
    classify: (call) => tools.classify(call),
    async execute(call, ctx) {
      const effectiveToolName = resolveEffectiveToolName(call)
      if (effectiveToolName !== 'rest') {
        const result = await tools.execute(call, ctx)
        if (!AUTONOMY_MAINTENANCE_TOOL_NAMES.has(effectiveToolName)) return result
        return {
          ...result,
          outcome: {
            ok: result.outcome?.ok ?? true,
            ...result.outcome,
            progress: false,
          },
        }
      }
      const instruction = '定时自主探索尚未结束，本轮不能再次 rest。先按 autonomy_discovery_required 的 direction 做一次具体、有界的机会检查；不要改写休息理由或创建 Schedule 代替。'
      return {
        content: JSON.stringify({
          ok: false,
          code: 'rest_unavailable_during_autonomy_discovery',
          instruction,
        }),
        outcome: {
          ok: false,
          code: 'rest_unavailable_during_autonomy_discovery',
          error: instruction,
          progress: false,
        },
      }
    },
  }
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

async function waitForEventOrTimeout(
  queue: EventQueue<BotEvent>,
  timeoutMs: number,
): Promise<'event' | 'elapsed'> {
  const eventAbort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      queue
        .waitForEvent({ signal: eventAbort.signal })
        .then(() => 'event' as const),
      new Promise<'elapsed'>((resolve) => {
        timer = setTimeout(() => resolve('elapsed'), timeoutMs)
      }),
    ])
  } finally {
    eventAbort.abort()
    if (timer != null) clearTimeout(timer)
  }
}
