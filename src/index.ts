import { prisma } from './database/client.js'
import { connectNapcat, registerNapcatHandlers, type IngestedMessage } from './bot/core.js'
import { napcat } from './bot/napcat.js'
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
import { resolveTargetMetadataMaps } from './agent/resolve-target-meta.js'
import { createDedupEnqueue } from './agent/dedup-enqueue.js'

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
  log.info(
    {
      groupIds: config.botTargetGroupIds,
      privateUserIds: config.botTargetPrivateUserIds,
    },
    'qq-bot-v2 single-context MVP-2 启动',
  )
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

  // 5. 事件队列 + messageRowId 去重 (replay-missed × live event 重叠时去重, 见 dedup-enqueue.ts)
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const enqueueMessageEvent = createDedupEnqueue(eventQueue)

  // 6. NapCat: register handlers (sync). 实时消息会进 onMessageReady → enqueueMessageEvent.
  const onMessageReady = async (input: IngestedMessage) => {
    if (input.kind === 'group') {
      enqueueMessageEvent({
        type: 'napcat_message',
        messageRowId: input.messageRowId,
        groupId: input.groupId,
        groupName: input.groupName,
        messageId: input.messageId,
        senderId: input.senderId,
        senderNickname: input.senderNickname,
        mentionedSelf: input.mentionedSelf,
        sentAt: input.sentAt,
        renderedText: input.renderedText,
      })
    } else {
      enqueueMessageEvent({
        type: 'napcat_private_message',
        messageRowId: input.messageRowId,
        peerId: input.peerId,
        messageId: input.messageId,
        senderId: input.senderId,
        senderNickname: input.senderNickname,
        mentionedSelf: true,
        sentAt: input.sentAt,
        renderedText: input.renderedText,
      })
    }
  }
  registerNapcatHandlers({ onMessageReady })

  // 7. NapCat connect (D2: must be before resolveTargetMetadataMaps)
  await connectNapcat()

  // 8. 启动元数据 (群名 / 私聊昵称) — 用于拼 system prompt
  const targetMetadata = await resolveTargetMetadataMaps({
    napcat,
    groupIds: config.botTargetGroupIds,
    privateUserIds: config.botTargetPrivateUserIds,
  })

  // 9. 关机期间消息回放. 在 connect 之后跑也安全, 因为 enqueueMessageEvent 按
  //    messageRowId 去重 (步骤 5), live 已经先入队的就不会被 replay 重复入队.
  const replayResult = await replayMissedMessages(persisted?.lastWakeAt ?? null, {
    enqueueMessageEvent,
    selfNumber: config.selfNumber,
  })
  log.info({ enqueued: replayResult.enqueued }, 'replay-missed 完成')

  // 10. 工具集 + bot system prompt (启动后定型, 进程内不变)
  const tools = createToolExecutor(
    buildBotTools({
      sender: messageSender,
      groupIdWhitelist: config.botTargetGroupIds,
      privateUserIdWhitelist: config.botTargetPrivateUserIds,
    }),
  )
  const systemPrompt = buildBotSystemPrompt({
    groupIds: config.botTargetGroupIds,
    privateUserIds: config.botTargetPrivateUserIds,
    metadata: targetMetadata,
  })

  // 11. BotLoopAgent
  const agent = createBotLoopAgent({
    systemPrompt,
    context,
    eventQueue,
    llm,
    tools,
    snapshotRepo,
    renderEvent: renderBotEvent,
  })

  // 12. 进入主循环
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
