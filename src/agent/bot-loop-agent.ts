import type { AgentContext } from './agent-context.js'
import type { LlmClient } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { maybeCompactConversation, type MaybeCompactOptions } from './compaction.js'
import { createLogger } from '../logger.js'

const log = createLogger('BOT_LOOP')

export interface BotLoopAgentDeps {
  systemPrompt: string
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  tools: ToolExecutor
  snapshotRepo: BotSnapshotRepo
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
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000
const DEFAULT_EVENT_DEBOUNCE_MS = 3_000

export interface BotLoopAgent {
  start(): Promise<void>
  stop(): Promise<void>
  /** 测试用:跑一次 runOnce 不进入 while 循环。 */
  runOnceForTest(): Promise<void>
}

export function createBotLoopAgent(deps: BotLoopAgentDeps): BotLoopAgent {
  let stopRequested = false
  let cancelDebounceSleep: (() => void) | null = null
  let lastWakeAt: Date | null = null
  let roundIndex = 0

  async function drainEvents(): Promise<number> {
    let consumed = 0
    while (true) {
      const event = deps.eventQueue.dequeue()
      if (!event) break
      consumed++
      // wake 是控制信号 (stop / 未来 timer), 不进 context
      if (event.type === 'wake') continue
      const rendered = await deps.renderEvent(event)
      if (rendered == null || rendered.length === 0) continue
      deps.context.appendUserMessage(rendered)
      lastWakeAt = new Date()
    }
    return consumed
  }

  async function runRound(): Promise<{ hadToolCalls: boolean }> {
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

    // 即使 content 为空, 只要有 toolCalls 也要 append, 这样 tool_results 才能 anchor。
    if (completion.content.length > 0 || completion.toolCalls.length > 0) {
      deps.context.appendAssistantTurn({
        content: completion.content,
        toolCalls: completion.toolCalls,
      })
    }

    for (const call of completion.toolCalls) {
      const result = await deps.tools.execute(call, {
        eventQueue: deps.eventQueue,
        roundIndex,
      })
      deps.context.appendToolResult({ toolCallId: call.id, content: result.content })
    }

    return { hadToolCalls: completion.toolCalls.length > 0 }
  }

  async function maybeCompact(): Promise<void> {
    try {
      await maybeCompactConversation(deps.context, deps.compactOptions)
    } catch (err) {
      log.error({ err }, 'compaction_failed_skipped')
    }
  }

  async function step(): Promise<{ hadToolCalls: boolean }> {
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
    const consumed = await drainEvents()
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: consumed }, 'round_start')

    if (deps.context.getSnapshot().messages.length === 0) {
      return { hadToolCalls: false }
    }

    const { hadToolCalls } = await runRound()
    await deps.snapshotRepo.save({
      snapshot: deps.context.exportPersistedSnapshot(),
      lastWakeAt,
    })
    await maybeCompact()
    return { hadToolCalls }
  }

  // 节奏 = LLM 意图 (跟文章版 stop_reason != tool_use 同形):
  //   有 toolCall (含 wait): 立即跑下一轮让 LLM 看 tool result.
  //   无 toolCall (纯 text / context 空): LLM 没事做 → 阻塞等事件, 不烧 token.
  // waitForEvent 在队列非空时立即 resolve, stop 时手动 enqueue wake 也能解开.
  async function runOnce(): Promise<void> {
    const { hadToolCalls } = await step()
    if (!hadToolCalls && !stopRequested) {
      await deps.eventQueue.waitForEvent()
    }
  }

  async function loop(): Promise<void> {
    while (!stopRequested) {
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
      // 测试用: 跑一次 step (drain + round + persist + compact), 跳过 runOnce 的 waitForEvent
      // 守护, 否则空 context 测试会阻塞.
      await step()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
