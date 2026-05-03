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
}

const DEFAULT_ERROR_BACKOFF_MS = 5_000

export interface BotLoopAgent {
  start(): Promise<void>
  stop(): Promise<void>
  /** 测试用:跑一次 runOnce 不进入 while 循环。 */
  runOnceForTest(): Promise<void>
}

export function createBotLoopAgent(deps: BotLoopAgentDeps): BotLoopAgent {
  let stopRequested = false
  let lastWakeAt: Date | null = null
  let roundIndex = 0

  async function drainEvents(): Promise<{ consumed: number }> {
    let consumed = 0
    while (true) {
      const event = deps.eventQueue.dequeue()
      if (!event) break
      consumed++

      if (event.type === 'wake') {
        // wake 是控制信号 (stop / 未来 timer), 不进 context
        continue
      }
      const rendered = await deps.renderEvent(event)
      if (rendered == null || rendered.length === 0) continue
      deps.context.appendUserMessage(rendered)
      lastWakeAt = new Date()
    }
    return { consumed }
  }

  async function runRound(): Promise<void> {
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
  }

  async function persistSnapshot(): Promise<void> {
    const persisted = deps.context.exportPersistedSnapshot()
    await deps.snapshotRepo.save({ snapshot: persisted, lastWakeAt })
  }

  async function maybeCompact(): Promise<void> {
    try {
      await maybeCompactConversation(deps.context, deps.compactOptions)
    } catch (err) {
      log.error({ err }, 'compaction_failed_skipped')
    }
  }

  async function runOnceCore(): Promise<{ ranRound: boolean }> {
    const drainResult = await drainEvents()
    log.debug({ roundIndex: roundIndex + 1, eventsConsumed: drainResult.consumed }, 'round_start')

    const snapshot = deps.context.getSnapshot()
    if (snapshot.messages.length === 0) {
      return { ranRound: false }
    }

    await runRound()
    await persistSnapshot()
    await maybeCompact()
    return { ranRound: true }
  }

  async function runOnce(): Promise<void> {
    const { ranRound } = await runOnceCore()

    // 守护 1: context 还空(首次启动 + 没有真消息),阻塞等首条事件
    if (!ranRound) {
      await deps.eventQueue.waitForEvent()
      return
    }

    // 守护 2: round 结束后队列为空(LLM 没 call wait 或 wait 已结束),block 等下个事件,
    // 避免无新输入的情况下 LLM 持续循环烧 token。
    if (deps.eventQueue.size() === 0 && !stopRequested) {
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
      // 唤醒可能阻塞在 wait tool 里的 round, 让 stopRequested 检查能跑到
      deps.eventQueue.enqueue({ type: 'wake' })
      log.info('bot_loop_stop_requested')
    },
    async runOnceForTest() {
      // 测试用: 跑核心逻辑 (drain + round + persist + compact),跳过外层的 waitForEvent 守护,
      // 否则空 context 测试会阻塞等事件。
      await runOnceCore()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
