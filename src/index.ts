import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { createLogger } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'
import { config } from './config/index.js'
import { createConversationScheduler, type ConversationScheduler } from './conversation/scheduler.js'
import { createConversationMemoryQueue } from './queue/conversation-memory-queue.js'
import type { ConversationQueue } from './queue/conversation-queue.js'
import { createConversationWorker, type ProactiveHandler } from './conversation/worker.js'
import { createMentionDispatcher } from './conversation/dispatcher.js'
import { evaluateAndReply } from './responder/proactive/generator.js'
import { getAgentProfile } from './config/agent-profiles.js'
import { startHttpServer, addRoute } from './server/http.js'
import { handlePlaygroundReplay, handlePlaygroundRun, handleReplayTraceGet } from './server/playground.js'
import { handleMediaReanalyze } from './server/media-reanalyze.js'
import type http from 'node:http'

let stopMemoryJob: () => void = () => {}
let conversationQueue: ConversationQueue | null = null
let conversationScheduler: ConversationScheduler | null = null
let httpServer: http.Server | null = null
const log = createLogger('APP')

const ASYNC_MENTION_MERGE_WINDOW_MS = 30_000

function isGptModel(model: string): boolean {
  return model.toLowerCase().startsWith('gpt')
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

  // proactive 状态
  const lastBotReplyAtMap = new Map<number, number>()
  const proactiveTimestamps = new Map<number, number[]>()

  const ONE_HOUR_MS = 60 * 60 * 1000

  function getRecentProactiveTimestamps(groupId: number): number[] {
    const timestamps = proactiveTimestamps.get(groupId) ?? []
    const now = Date.now()
    const recent = timestamps.filter((ts) => now - ts < ONE_HOUR_MS)
    proactiveTimestamps.set(groupId, recent)
    return recent
  }

  const proactiveHandler: ProactiveHandler = {
    async evaluate(groupId, messagesSinceLastEval) {
      return evaluateAndReply(groupId, {
        lastBotReplyAt: lastBotReplyAtMap.get(groupId),
        recentProactiveTimestamps: getRecentProactiveTimestamps(groupId),
        messagesSinceLastEval,
        onProactiveAttempt() {
          const timestamps = proactiveTimestamps.get(groupId) ?? []
          proactiveTimestamps.set(groupId, [...timestamps, Date.now()])
        },
      })
    },
  }

  const conversationWorker = createConversationWorker({
    proactiveHandler,
    onBotReplySent(groupId) {
      lastBotReplyAtMap.set(groupId, Date.now())
    },
  })

  const PROACTIVE_DEBOUNCE_MS = 90_000
  const PROACTIVE_MAX_WAIT_MS = 300_000

  conversationScheduler = createConversationScheduler({
    mergeWindowMs: ASYNC_MENTION_MERGE_WINDOW_MS,
    proactiveDebounceMs: PROACTIVE_DEBOUNCE_MS,
    proactiveMaxWaitMs: PROACTIVE_MAX_WAIT_MS,
    worker: (batch) => conversationWorker.run(batch),
  })
  conversationQueue = createConversationMemoryQueue({
    onMention: (event) => conversationScheduler?.onMention(event),
  })
  const mentionDispatcher = createMentionDispatcher({
    selfNumber: config.selfNumber,
    queue: conversationQueue,
  })
  conversationQueue.start()
  stopMemoryJob = startMemoryRefreshJob()
  log.info(
    { mergeWindowMs: ASYNC_MENTION_MERGE_WINDOW_MS, proactiveDebounceMs: PROACTIVE_DEBOUNCE_MS, proactiveMaxWaitMs: PROACTIVE_MAX_WAIT_MS },
    'Conversation scheduler started (mention + proactive)',
  )
  log.info('Memory refresh job started')
  await startBot({ mentionDispatcher, conversationScheduler })
}

async function shutdown() {
  log.info('Shutting down...')
  stopMemoryJob()
  conversationQueue?.stop()
  conversationScheduler?.stop()
  jobQueue.stop()
  httpServer?.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  log.fatal(err, 'Failed to start')
  process.exit(1)
})
