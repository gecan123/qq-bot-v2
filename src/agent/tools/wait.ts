import { z } from 'zod'
import { config } from '../../config/index.js'
import { createLogger } from '../../logger.js'
import type { Tool } from '../tool.js'

const log = createLogger('TOOL_WAIT')

/**
 * wait 工具: bot 没事可做时挂在这里, 直到有新事件 — 或者直到 IDLE_HINT_MS 到点。
 *
 * 节奏: wait 是一次 toolCall, 主循环看到 hadToolCalls=true → 立即跑下一轮.
 * idle 触发只需返回 [空闲提示] tool result, 不必额外 enqueue wake — 下一轮 LLM 自然看到.
 *
 * 红线 5: idle hint 文本是常量, 同样 trigger 输出同样字节; 一旦 append 进 messages 数组就冻结,
 * snapshot 持久化里就有, 重启后 LLM 看到的 prefix 完全一致。idle 引信不重放 — 重启后第一次
 * wait 才装上, 中间空 idleHintMs 才 fire 一次, 跟"重启后 cache 失效"语义对齐。
 */
export interface WaitToolDeps {
  /** 注入用 (测试 / 不同部署调参). 默认读 config.idleHintMs. */
  idleHintMs?: number
  /** 注入用 (测试). 默认 setTimeout / clearTimeout. */
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const defaultTimer = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface WaitArgs {
  reason?: string
}

export function createWaitTool(deps: WaitToolDeps = {}): Tool<WaitArgs> {
  const idleHintMs = deps.idleHintMs ?? config.idleHintMs
  const timer = deps.timer ?? defaultTimer

  return {
    name: 'wait',
    description: [
      '当前没什么想发的、刚发过类似内容、或群里在聊跟你无关的内容时调用 wait。这会让你休眠到下个外部事件 (新群消息) 到达。',
      '优先 wait 而不是硬找话说。',
      `长时间没真事件你会拿到一条 [空闲提示] tool result (默认 ${Math.round(idleHintMs / 60000)} 分钟). 收到时可以选择: 调 list_reddit 看看有啥 / 主动找最近没说话的人或群起话题 / 还是继续 wait。判断比频率重要, 不必每次空闲都刷东西。`,
    ].join(' '),
    schema: z.object({
      reason: z.string().optional().describe('选择 wait 的简短理由 (仅日志用,不会发出去)'),
    }),
    async execute(args, ctx) {
      let timerHandle: unknown = null
      let idleFired = false

      log.info({ idleHintMs, reason: args.reason ?? null }, 'wait_enter')
      const enteredAt = Date.now()

      const timeoutPromise = new Promise<'idle'>((resolve) => {
        timerHandle = timer.setTimeout(() => {
          idleFired = true
          resolve('idle')
        }, idleHintMs)
      })

      try {
        const result = await Promise.race([
          ctx.eventQueue.waitForEvent().then(() => 'event' as const),
          timeoutPromise,
        ])

        const elapsedMs = Date.now() - enteredAt
        if (result === 'idle') {
          log.info({ elapsedMs }, 'wait_idle_fired')
          // wait 是一次 toolCall → 主循环 hadToolCalls=true → 立即跑下一轮看 tool result, 不用额外戳.
          const minutes = Math.round(idleHintMs / 60_000)
          return {
            content: `[空闲提示] 已闲置约 ${minutes} 分钟. 你处于自由时段, 可以 list_reddit 看看有啥值得分享的 / 主动找谁聊 / 或者继续 wait. 别每次空闲都硬刷, 你的判断比频率重要.`,
          }
        }
        log.info({ elapsedMs }, 'wait_resumed_by_event')
        return { content: 'ok' }
      } finally {
        if (!idleFired && timerHandle != null) {
          timer.clearTimeout(timerHandle)
        }
      }
    },
  }
}

/** 默认实例: 工具注册表用这个 (读 config.idleHintMs). */
export const waitTool = createWaitTool()
