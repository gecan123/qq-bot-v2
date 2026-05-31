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
      '让你休眠到下个外部事件 (新群 / 私聊消息) 到达.',
      `长时间无事件会自动返回一条 [空闲提示] tool result (默认 ${Math.round(idleHintMs / 60000)} 分钟); 它跟 [好奇心 tick] 一样, 是让你自由活动的时机, 不是要回复的对象.`,
      '一般在已经处理完当前消息、没有想说的话、或刚看完外界暂时不想发言时使用.',
    ].join(' '),
    schema: z.object({
      reason: z.string().optional().describe('此刻的心情或状态速写 (仅日志, 不会发出去; 每次写点不一样的)'),
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
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

        if (result === 'idle') {
          log.info({ elapsedMs }, 'wait_idle_fired')
          const minutes = Math.round(idleHintMs / 60_000)
          return {
            content: `[空闲提示] 当前北京时间: ${now}. 已闲置约 ${minutes} 分钟. 去翻翻外面在发生什么 — list_reddit 换个 subreddit 刷一刷 / 查个你好奇的东西 / 或者找人聊两句.`,
          }
        }
        log.info({ elapsedMs }, 'wait_resumed_by_event')
        return { content: `[当前北京时间: ${now}] ok` }
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
