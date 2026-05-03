import { prisma } from './database/client.js'
import { startBot, type IngestedMessage } from './bot/core.js'
import { createLogger } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import { config } from './config/index.js'
import { messageSender } from './messaging/message-sender.js'

import { createAgentContext } from './agent/agent-context.js'
import { InMemoryEventQueue } from './agent/event-queue.js'
import type { BotEvent } from './agent/event.js'
import { createBotSnapshotRepo } from './agent/snapshot-repo.js'
import { createLlmClient } from './agent/llm-client.js'
import { buildBotSystemPrompt } from './agent/bot-system-prompt.js'
import { createToolExecutor } from './agent/tool.js'
import { buildBotTools } from './agent/tools/index.js'
import { createBotLoopAgent } from './agent/bot-loop-agent.js'
import { renderBotEvent } from './agent/render-event.js'
import { replayMissedMessages } from './agent/replay-missed.js'

const log = createLogger('APP')

function isGptModel(model: string): boolean {
  return model.toLowerCase().startsWith('gpt')
}

function buildMediaProvider(): RoutingProvider {
  const { defaultProvider: defaultProviderName, defaultModel, providers, scenarios } = config.llm
  const defaultProviderConfig = providers[defaultProviderName]
  if (!defaultProviderConfig) {
    throw new Error(`Default LLM provider not found: ${defaultProviderName}`)
  }
  const defaultProvider = new OpenAIProvider(
    defaultProviderConfig.url,
    defaultProviderConfig.apiKey,
    defaultModel,
    {
      imageStreamMode: scenarios.describeImage.streamMode,
    },
  )

  const routes: ConstructorParameters<typeof RoutingProvider>[1] = {}
  for (const [key, s] of Object.entries(scenarios)) {
    if (!s.provider && !s.model) continue
    const providerName = s.provider ?? defaultProviderName
    const providerConfig = providers[providerName]
    if (!providerConfig) continue
    routes[key as keyof typeof routes] = new OpenAIProvider(
      providerConfig.url,
      providerConfig.apiKey,
      s.model ?? defaultModel,
      {
        imageStreamMode: key === 'describeImage' ? scenarios.describeImage.streamMode : undefined,
      },
    )
  }

  if (scenarios.describeImage.fallbackProvider || scenarios.describeImage.fallbackModel) {
    const fallbackProviderName = scenarios.describeImage.fallbackProvider ?? defaultProviderName
    const fallbackProviderConfig = providers[fallbackProviderName]
    const fallbackModel = scenarios.describeImage.fallbackModel ?? defaultModel
    if (fallbackProviderConfig) {
      routes.describeImageFallback = new OpenAIProvider(
        fallbackProviderConfig.url,
        fallbackProviderConfig.apiKey,
        fallbackModel,
        {
          imageStreamMode: isGptModel(fallbackModel)
            ? scenarios.describeImage.fallbackGptStreamMode ?? 'off'
            : 'off',
        },
      )
    }
  }

  return new RoutingProvider(defaultProvider, routes)
}

async function main() {
  log.info({ targetGroup: config.botTargetGroupId }, 'qq-bot-v2 single-context MVP 启动')
  await prisma.$connect()
  log.info('数据库已连接')

  // 1. 媒体描述用的 LLM provider routing (与 agent 自身的 LLM 客户端独立)
  const mediaProvider = buildMediaProvider()
  setLlmProvider(mediaProvider)
  log.info(
    {
      defaultProvider: config.llm.defaultProvider,
      defaultModel: config.llm.defaultModel,
    },
    'LLM media provider 已注册',
  )

  // 2. 媒体描述异步队列
  jobQueue.start()

  // 3. Agent 自己的 LLM 客户端 (走 default provider/model, 后续可以单独换)
  const llm = createLlmClient()

  // 4. 永续上下文 + 持久化 + 启动恢复
  const snapshotRepo = createBotSnapshotRepo()
  const persisted = await snapshotRepo.load()
  const context = createAgentContext()
  if (persisted) {
    context.restorePersistedSnapshot(persisted.snapshot)
    log.info(
      {
        messages: persisted.snapshot.messages.length,
        lastWakeAt: persisted.lastWakeAt?.toISOString() ?? null,
      },
      '从持久化 snapshot 恢复 AgentContext',
    )
  } else {
    log.info('AgentContext 从空启动 (无 snapshot)')
  }

  // 5. 事件队列 + 关机期间消息回放
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const replayResult = await replayMissedMessages(persisted?.lastWakeAt ?? null, {
    eventQueue,
    selfNumber: config.selfNumber,
  })
  log.info({ enqueued: replayResult.enqueued }, 'replay-missed 完成')

  // 6. 工具集
  const tools = createToolExecutor(buildBotTools({ sender: messageSender }))

  // 7. BotLoopAgent
  const agent = createBotLoopAgent({
    systemPrompt: buildBotSystemPrompt(),
    context,
    eventQueue,
    llm,
    tools,
    snapshotRepo,
    renderEvent: renderBotEvent,
  })

  // 8. NapCat 接入: 真消息 → ingest → enqueue
  const onMessageReady = async (input: IngestedMessage) => {
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: input.messageRowId,
      groupId: input.groupId,
      messageId: input.messageId,
      senderId: input.senderId,
      senderNickname: input.senderNickname,
      mentionedSelf: input.mentionedSelf,
      sentAt: input.sentAt,
      renderedText: input.renderedText,
    })
  }
  await startBot({ onMessageReady })

  // 9. 进入主循环
  log.info('BotLoopAgent 进入主循环')
  await agent.start()
}

async function shutdown() {
  log.info('Shutting down...')
  jobQueue.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  log.fatal(err, 'Failed to start')
  process.exit(1)
})
