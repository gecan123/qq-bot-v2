import type { AgentContext } from './agent-context.js'
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { maybeCompactConversation, type MaybeCompactOptions } from './compaction.js'
import { injectStickerPoolAfterCompaction } from './sticker-pool.js'
import { recordTokenUsage } from './token-stats.js'
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
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000
const DEFAULT_EVENT_DEBOUNCE_MS = 3_000
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 86_400_000
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
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = deps.initialLastWakeAt ?? null
  let mailboxCursors: MailboxCursors = { ...deps.initialMailboxCursors }
  let roundIndex = 0

  async function drainEvents(): Promise<{ consumed: number; disclosed: number }> {
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
    return { consumed: events.length, disclosed }
  }

  async function runRound(): Promise<{
    inputTokens: number | null
    shouldWaitForExternalEvent: boolean
  }> {
    roundIndex++
    const snapshot = deps.context.getSnapshot()
    const tools = deps.tools.list()

    const completion = await deps.llm.chat({
      systemPrompt: deps.systemPrompt,
      messages: snapshot.messages,
      tools,
    })

    log.info(
      {
        roundIndex,
        toolCallCount: completion.toolCalls.length,
        toolNames: completion.toolCalls.map((c) => c.name),
        contentLen: completion.content.length,
        inputTokens: completion.usage.inputTokens,
        cachedTokens: completion.usage.cachedTokens,
        outputTokens: completion.usage.outputTokens,
        model: completion.model,
      },
      'round_llm_done',
    )

    recordTokenUsage({
      operation: 'agent.chat',
      roundIndex,
      inputTokens: completion.usage.inputTokens,
      cachedTokens: completion.usage.cachedTokens,
      outputTokens: completion.usage.outputTokens,
      model: completion.model,
    })

    if (completion.content.length > 0) {
      log.warn(
        {
          roundIndex,
          contentLen: completion.content.length,
          toolCallCount: completion.toolCalls.length,
        },
        'assistant_text_dropped_from_context',
      )
    }

    if (completion.toolCalls.length > 0) {
      deps.context.appendAssistantTurn({
        content: '',
        toolCalls: completion.toolCalls,
      })
    }

    let shouldWaitForExternalEvent = false
    for (const call of completion.toolCalls) {
      const result = await deps.tools.execute(call, {
        eventQueue: deps.eventQueue,
        roundIndex,
      })
      if (call.name === 'send_message' && isDeliveredSendMessageResult(result.content)) {
        shouldWaitForExternalEvent = true
      }
      deps.context.appendToolResult({ toolCallId: call.id, content: result.content })
    }

    return {
      inputTokens: completion.usage.inputTokens,
      shouldWaitForExternalEvent,
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

  async function step(): Promise<{ ranRound: boolean; shouldWaitForExternalEvent: boolean }> {
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
    const { consumed, disclosed } = await drainEvents()
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: consumed, eventsDisclosed: disclosed }, 'round_start')

    if (consumed > 0 && disclosed === 0) {
      return { ranRound: false, shouldWaitForExternalEvent: false }
    }

    if (deps.context.getSnapshot().messages.length === 0) {
      return { ranRound: false, shouldWaitForExternalEvent: false }
    }

    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      mailboxCursors,
      lastWakeAt,
    })

    const { inputTokens, shouldWaitForExternalEvent } = await runRound()
    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      mailboxCursors,
      lastWakeAt,
    })
    await maybeCompact(inputTokens)
    return { ranRound: true, shouldWaitForExternalEvent }
  }

  async function runOnce(): Promise<void> {
    const { ranRound, shouldWaitForExternalEvent } = await step()
    if (!ranRound && !stopRequested) {
      await waitForExternalEvent()
    }
    if (ranRound && shouldWaitForExternalEvent && !stopRequested) {
      log.debug({ roundIndex }, 'round_waiting_after_send_message')
      await waitForExternalEvent()
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
    async runOnceForTest() {
      await step()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isDeliveredSendMessageResult(content: unknown): boolean {
  if (typeof content !== 'string') return false
  try {
    const parsed = JSON.parse(content) as unknown
    return !!(
      parsed &&
      typeof parsed === 'object' &&
      'status' in parsed &&
      (parsed as { status?: unknown }).status === 'sent'
    )
  } catch {
    return false
  }
}
