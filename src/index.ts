import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'
import { config } from './config/index.js'
import { createConversationScheduler, type ConversationScheduler } from './conversation/scheduler.js'
import { createConversationMemoryQueue } from './queue/conversation-memory-queue.js'
import type { ConversationQueue } from './queue/conversation-queue.js'
import { createConversationWorker } from './conversation/worker.js'
import { createMentionDispatcher } from './conversation/dispatcher.js'
import { startHttpServer, addRoute } from './server/http.js'
import { handlePlaygroundRun } from './server/playground.js'
import { handleMediaReanalyze } from './server/media-reanalyze.js'
import type http from 'node:http'

let stopMemoryJob: () => void = () => {}
let conversationQueue: ConversationQueue | null = null
let conversationScheduler: ConversationScheduler | null = null
let httpServer: http.Server | null = null

const ASYNC_MENTION_MERGE_WINDOW_MS = 30_000

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')

  const { baseUrl, apiKey, model, scenarios } = config.llm
  const defaultProvider = new OpenAIProvider(baseUrl, apiKey, model)

  const routes = Object.fromEntries(
    Object.entries(scenarios)
      .filter(([, s]) => s.baseUrl || s.apiKey || s.model)
      .map(([key, s]) => [
        key,
        new OpenAIProvider(s.baseUrl ?? baseUrl, s.apiKey ?? apiKey, s.model ?? model),
      ]),
  ) as ConstructorParameters<typeof RoutingProvider>[1]

  const routing = new RoutingProvider(defaultProvider, routes)
  setLlmProvider(routing)
  log.info(
    {
      default: model,
      scenarios: Object.fromEntries(
        Object.entries(scenarios)
          .filter(([, s]) => s.model)
          .map(([key, s]) => [key, { model: s.model }]),
      ),
    },
    'LLM routing provider registered',
  )

  addRoute('POST', '/api/playground/run', handlePlaygroundRun)
  addRoute('POST', '/api/media/:id/reanalyze', handleMediaReanalyze)
  const apiPort = Number(process.env.BOT_API_PORT ?? '3101')
  httpServer = startHttpServer(apiPort)

  jobQueue.start()
  const conversationWorker = createConversationWorker()
  conversationScheduler = createConversationScheduler({
    mergeWindowMs: ASYNC_MENTION_MERGE_WINDOW_MS,
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
  log.info({ mergeWindowMs: ASYNC_MENTION_MERGE_WINDOW_MS }, 'Async mention conversation scheduler started')
  log.info('Memory refresh job started')
  await startBot({ mentionDispatcher })
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
