// 入口文件在 Phase 2 wiring 中重写。
// Phase 0 deletion + Phase 1 fresh agent layer 完成后，此处 wire:
//   1. 连 prisma + 启动 jobQueue
//   2. 装载 LLM provider routing
//   3. 创建 BotAgentContext / BotEventQueue / BotLoopAgent
//   4. 接 NapCat → enqueue
//   5. agent.start()
import { config } from './config/index.js'
import { createLogger } from './logger.js'

const log = createLogger('APP')

async function main() {
  log.info({ targetGroup: config.botTargetGroupId }, 'qq-bot-v2 single-context MVP — Phase 1/2 待 wiring')
  // TODO Phase 2: wire BotLoopAgent + NapCat ingest here
}

main().catch((err) => {
  log.fatal(err, 'Failed to start')
  process.exit(1)
})
