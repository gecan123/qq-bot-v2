import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { createLogger } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import { config } from './config/index.js'
import { recoverConversationStartupState } from './conversation/recovery.js'
import { startHttpServer, addRoute } from './server/http.js'
import { handlePlaygroundReplay, handlePlaygroundRun, handleReplayTraceGet } from './server/playground.js'
import { handleMediaReanalyze } from './server/media-reanalyze.js'
import { createRootRuntimeManager } from './runtime/root-runtime.js'
import { createPassiveMentionProcessor } from './runtime/passive-mention-processor.js'
import { getGroupMessagesAfterRowId, getLatestGroupMessageRowId } from './database/messages.js'
import { getMessageTimestamp } from './utils/message-time.js'
import type { ParsedSegment } from './types/message-segments.js'
import type http from 'node:http'
import { pathToFileURL } from 'node:url'

let httpServer: http.Server | null = null
let rootRuntime: ReturnType<typeof createRootRuntimeManager> | null = null
const log = createLogger('APP')

function isGptModel(model: string): boolean {
  return model.toLowerCase().startsWith('gpt')
}

function resolveAssistantTurnSenderId(turn: { senderThreadKey: string; mentionUserId?: bigint | number | null }): number {
  if (turn.mentionUserId != null) {
    return Number(turn.mentionUserId)
  }

  return Number(turn.senderThreadKey.replace('sender:', ''))
}

export async function replayPersistedRootRuntimeDelta(params: {
  groupIds: number[]
  rootRuntime: ReturnType<typeof createRootRuntimeManager>
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getLatestMessageRowId?: typeof getLatestGroupMessageRowId
  getTimestamp?: typeof getMessageTimestamp
}): Promise<void> {
  const getMessagesAfterRowId = params.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const getLatestMessageRowId = params.getLatestMessageRowId ?? getLatestGroupMessageRowId
  const getTimestamp = params.getTimestamp ?? getMessageTimestamp

  for (const groupId of params.groupIds) {
    const snapshot = params.rootRuntime.getSnapshot(groupId)
    const lastObservedMessageRowId = snapshot?.lastObservedMessageRowId
    if (lastObservedMessageRowId === undefined) {
      const latestMessageRowId = await getLatestMessageRowId(groupId)
      if (latestMessageRowId !== undefined) {
        await params.rootRuntime.primeGroupCursor({
          groupId,
          lastObservedMessageRowId: latestMessageRowId,
        })
      }
      log.info(
        {
          groupId,
          lastObservedMessageRowId: null,
          primedObservedMessageRowId: latestMessageRowId ?? null,
          replayedCount: 0,
          replayedMentionCount: 0,
        },
        'Root runtime primed cursor without historical replay',
      )
      continue
    }
    const replayMessages = await getMessagesAfterRowId(groupId, lastObservedMessageRowId)
    let replayedMentionCount = 0

    for (const message of replayMessages) {
      const segments = Array.isArray(message.content) ? (message.content as unknown as ParsedSegment[]) : []
      const createdAt = getTimestamp(message)
      const replayedMention = params.rootRuntime.dispatchPassiveMentionIfMentioned({
        groupId,
        messageId: Number(message.messageId),
        senderId: Number(message.senderId),
        createdAt: createdAt.getTime(),
        segments,
      })
      if (replayedMention) {
        replayedMentionCount++
      }
      await params.rootRuntime.ingestGroupMessage({
        groupId,
        messageRowId: message.id,
        messageId: Number(message.messageId),
        senderId: Number(message.senderId),
        senderNickname: message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId),
        segments,
        createdAt,
      })
    }

    log.info(
      {
        groupId,
        replayedCount: replayMessages.length,
        replayedMentionCount,
        lastObservedMessageRowId: lastObservedMessageRowId ?? null,
      },
      'Root runtime replayed persisted message delta',
    )
  }
}

export async function recoverStartupAndStartPassiveRuntime(params: {
  groupIds: number[]
  rootRuntime: ReturnType<typeof createRootRuntimeManager>
  recoverConversationStartupStateFn?: typeof recoverConversationStartupState
}): Promise<void> {
  const recoverConversationStartupStateFn =
    params.recoverConversationStartupStateFn ?? recoverConversationStartupState

  await recoverConversationStartupStateFn({
    groupIds: params.groupIds,
    onAssistantTurnRecovered: async (turn) => {
      await params.rootRuntime.markPassiveReplyDelivered({
        groupId: turn.groupId,
        senderId: resolveAssistantTurnSenderId(turn),
        incorporatedMessageRowId: turn.incorporatedMessageRowId,
        text: turn.text,
      })
    },
  })

  params.rootRuntime.startPassiveExecution()
}

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')

  const { defaultProvider: defaultProviderName, defaultModel, providers, scenarios } = config.llm
  const defaultProviderConfig = providers[defaultProviderName]
  const defaultProvider = new OpenAIProvider(defaultProviderConfig.url, defaultProviderConfig.apiKey, defaultModel, {
    imageStreamMode: scenarios.describeImage.streamMode,
  })

  const routes: ConstructorParameters<typeof RoutingProvider>[1] = {}
  for (const [key, s] of Object.entries(scenarios)) {
    if (!s.provider && !s.model) continue
    const providerName = s.provider ?? defaultProviderName
    const providerConfig = providers[providerName]
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

  const routing = new RoutingProvider(defaultProvider, routes)
  setLlmProvider(routing)
  log.info(
    {
      default: { provider: defaultProviderName, model: defaultModel },
      scenarios: Object.fromEntries(
        Object.entries(scenarios)
          .filter(([, s]) => s.provider || s.model)
          .map(([key, s]) => [
            key,
            {
              provider: s.provider ?? defaultProviderName,
              model: s.model ?? defaultModel,
              ...(key === 'describeImage' && (s.fallbackProvider || s.fallbackModel)
                ? {
                    fallbackProvider: s.fallbackProvider ?? defaultProviderName,
                    fallbackModel: s.fallbackModel ?? defaultModel,
                    ...(s.fallbackGptStreamMode ? { fallbackGptStreamMode: s.fallbackGptStreamMode } : {}),
                  }
                : {}),
            },
          ]),
      ),
    },
    'LLM routing provider registered',
  )

  addRoute('POST', '/api/playground/run', handlePlaygroundRun)
  addRoute('GET', '/api/playground/trace/:id', handleReplayTraceGet)
  addRoute('POST', '/api/playground/replay', handlePlaygroundReplay)
  addRoute('POST', '/api/media/:id/reanalyze', handleMediaReanalyze)
  const apiPort = Number(process.env.BOT_API_PORT ?? '3101')
  httpServer = startHttpServer(apiPort)

  jobQueue.start()
  const passiveMentionProcessor = createPassiveMentionProcessor({
    onAssistantTurnSent: async (turn) => {
      await rootRuntime?.markPassiveReplyDelivered({
        groupId: turn.groupId,
        senderId: resolveAssistantTurnSenderId(turn),
        incorporatedMessageRowId: turn.incorporatedMessageRowId,
        text: turn.text,
      })
    },
  })
  rootRuntime = createRootRuntimeManager({
    selfNumber: config.selfNumber,
    passiveWorker: (batch) => passiveMentionProcessor.run(batch),
  })
  const restoreResult = await rootRuntime.restore(config.groupIds)
  log.info(restoreResult, 'Root runtime restored')
  await replayPersistedRootRuntimeDelta({
    groupIds: config.groupIds,
    rootRuntime,
  })

  await startBot({ rootRuntime })
  await recoverStartupAndStartPassiveRuntime({
    groupIds: config.groupIds,
    rootRuntime,
  })
  log.info('Root runtime passive mention execution started')
}

async function shutdown() {
  log.info('Shutting down...')
  rootRuntime?.stopPassiveExecution?.()
  jobQueue.stop()
  httpServer?.close()
  await prisma.$disconnect()
  process.exit(0)
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1]
  if (!entryPath) {
    return false
  }

  return import.meta.url === pathToFileURL(entryPath).href
}

if (isDirectExecution()) {
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  main().catch((err) => {
    log.fatal(err, 'Failed to start')
    process.exit(1)
  })
}
