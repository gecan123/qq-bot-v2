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
import { createReplyDecisionEngine } from './runtime/reply-decision-engine.js'
import { createReplyExecutor } from './runtime/reply-executor.js'
import { createActionExecutor } from './runtime/action-executor.js'
import { getGroupMessagesAfterRowId, getLatestGroupMessageRowId } from './database/messages.js'
import { getMessageTimestamp } from './utils/message-time.js'
import type { ParsedSegment } from './types/message-segments.js'
import type http from 'node:http'
import { pathToFileURL } from 'node:url'
import { messageSender } from './messaging/message-sender.js'
import { parseV2exFeedTargets, startV2exForumPolling } from './curiosity/v2ex-connector.js'
import type { ForumReadItemInput } from './curiosity/forum-read-executor.js'
import { startProactiveScheduler } from './runtime/proactive-scheduler.js'
import { startIdleThread } from './runtime/idle-thread.js'

let httpServer: http.Server | null = null
let rootRuntime: ReturnType<typeof createRootRuntimeManager> | null = null
let runtimeSchedulerTimer: NodeJS.Timeout | null = null
let v2exForumTimers: NodeJS.Timeout[] = []
let proactiveSchedulerTimers: NodeJS.Timeout[] = []
let idleThreadTimers: NodeJS.Timeout[] = []
const proactiveDigestBuffer: ForumReadItemInput[] = []
const log = createLogger('APP')

function isGptModel(model: string): boolean {
  return model.toLowerCase().startsWith('gpt')
}

function isDirectAtSelf(segments: ParsedSegment[]): boolean {
  return segments.some((segment) => segment.type === 'at' && segment.targetId === String(config.selfNumber))
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
      if (isDirectAtSelf(segments)) {
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
      }, {
        executeDecisions: false,
        ingestSource: 'replay',
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
    includePrivateScenes: true,
    sender: messageSender,
  })

  params.rootRuntime.requeuePendingPassiveMentions(params.groupIds)
  params.rootRuntime.startPassiveExecution()
}

export function startRuntimeSchedulerTicks(params: {
  groupIds: number[]
  rootRuntime: ReturnType<typeof createRootRuntimeManager>
  intervalMs: number
  now?: () => Date
}): NodeJS.Timeout | null {
  if (params.intervalMs <= 0 || params.groupIds.length === 0) return null
  const now = params.now ?? (() => new Date())
  return setInterval(() => {
    const createdAt = now()
    for (const groupId of params.groupIds) {
      void params.rootRuntime.emitRuntimeEvent({
        eventKind: 'scheduler_tick',
        groupId,
        createdAt,
      })
    }
  }, params.intervalMs)
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
  const replyDecisionEngine = createReplyDecisionEngine()
  const actionExecutor = createActionExecutor({ sender: messageSender })
  const replyExecutor = createReplyExecutor({
    decisionEngine: replyDecisionEngine,
    actionExecutor,
  })
  const passiveMentionProcessor = createPassiveMentionProcessor({
    executor: replyExecutor,
  })
  rootRuntime = createRootRuntimeManager({
    selfNumber: config.selfNumber,
    passiveWorker: (batch) => passiveMentionProcessor.run(batch),
    replyExecutor: replyExecutor,
    replyExecutionEnabled: true,
    decisionEngine: replyDecisionEngine,
    replyDryRunEnabled: messageSender.isReplyDryRunEnabled?.() ?? config.botReplyDryRun,
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
  runtimeSchedulerTimer = startRuntimeSchedulerTicks({
    groupIds: config.groupIds,
    rootRuntime,
    intervalMs: config.runtimeSchedulerTickMs,
  })
  if (runtimeSchedulerTimer) {
    log.info({ intervalMs: config.runtimeSchedulerTickMs }, 'Root runtime scheduler ticks started')
  }
  v2exForumTimers = startV2exForumPolling({
    enabled: config.v2exForum.enabled,
    feeds: parseV2exFeedTargets(config.v2exForum.feeds.join(',')),
    intervalMs: config.v2exForum.pollIntervalMs,
    maxItemsPerFeed: config.v2exForum.maxItemsPerFeed,
    timeoutMs: config.v2exForum.timeoutMs,
    userAgent: config.v2exForum.userAgent,
    interestKeywords: config.v2exForum.interestKeywords,
    fetchDetails: config.v2exForum.fetchDetails,
    detailReplyLimit: config.v2exForum.detailReplyLimit,
    onPoll: ({ target, itemCount, readCount, items }) => {
      log.info({ target, itemCount, readCount }, 'V2EX read-only forum poll completed')
      if (items.length === 0) return
      const seen = new Set(proactiveDigestBuffer.map((i) => i.externalId))
      const fresh = items.filter((i) => !seen.has(i.externalId))
      if (fresh.length === 0) return
      proactiveDigestBuffer.unshift(...fresh)
      const limit = config.proactive.maxDigestItems
      if (proactiveDigestBuffer.length > limit) {
        proactiveDigestBuffer.length = limit
      }
    },
    onError: (error, target) => {
      log.warn({ err: error, target }, 'V2EX read-only forum poll failed')
    },
  })
  if (v2exForumTimers.length > 0 || config.v2exForum.enabled) {
    log.info(
      {
        feeds: config.v2exForum.feeds,
        intervalMs: config.v2exForum.pollIntervalMs,
        maxItemsPerFeed: config.v2exForum.maxItemsPerFeed,
      },
      'V2EX read-only forum polling started',
    )
  }
  proactiveSchedulerTimers = startProactiveScheduler({
    groupIds: config.groupIds,
    intervalMs: config.proactive.intervalMs,
    initialDelayMs: config.proactive.initialDelayMs,
    getForumDigest: () => buildProactiveDigest(proactiveDigestBuffer),
    actionExecutor,
  })
  if (proactiveSchedulerTimers.length > 0) {
    log.info(
      {
        groupIds: config.groupIds,
        intervalMs: config.proactive.intervalMs,
        initialDelayMs: config.proactive.initialDelayMs,
      },
      'Proactive scheduler started',
    )
  }
  idleThreadTimers = startIdleThread({
    groupIds: config.groupIds,
    intervalMs: config.idleThread.intervalMs,
    initialDelayMs: config.idleThread.initialDelayMs,
    activeWithinHours: config.idleThread.activeWithinHours,
    recentJournalLimit: config.idleThread.recentJournalLimit,
  })
  log.info('Root runtime passive mention execution started')
}

function buildProactiveDigest(items: ForumReadItemInput[]): string | null {
  if (items.length === 0) return null
  const lines = items.map((item) => {
    const author = item.author ? ` (by ${item.author})` : ''
    const url = item.url ? ` ${item.url}` : ''
    return `- ${item.title}${author}${url}`
  })
  return lines.join('\n')
}

async function shutdown() {
  log.info('Shutting down...')
  if (runtimeSchedulerTimer) {
    clearInterval(runtimeSchedulerTimer)
    runtimeSchedulerTimer = null
  }
  for (const timer of v2exForumTimers) {
    clearInterval(timer)
  }
  v2exForumTimers = []
  for (const timer of idleThreadTimers) {
    clearTimeout(timer)
    clearInterval(timer)
  }
  idleThreadTimers = []
  for (const timer of proactiveSchedulerTimers) {
    clearTimeout(timer)
    clearInterval(timer)
  }
  proactiveSchedulerTimers = []
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
