import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { prisma } from './database/client.js'
import type { IngestedMessage } from './bot/core.js'
import { createLogger } from './logger.js'
import { formatBeijingDateTime, formatBeijingIso } from './utils/beijing-time.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import {
  CLAUDE_CODE_PROVIDER_NAME,
  OPENAI_AGENT_PROVIDER_NAME,
  config,
} from './config/index.js'
import { buildMediaProvider } from './llm/media-provider.js'
import { messageSender } from './messaging/message-sender.js'

import { purgeOldData } from './database/retention.js'
import { createDailyRetentionRunner, type DailyRetentionRunner } from './database/retention-runner.js'
import { createAgentContext } from './agent/agent-context.js'
import { InMemoryEventQueue } from './agent/event-queue.js'
import { shouldQueueChatEvent, type BotEvent } from './agent/event.js'
import { createAgentLedgerRepo } from './agent/agent-ledger-repo.js'
import { createAgentLedgerLoader } from './agent/agent-ledger-loader.js'
import { createLlmClient } from './agent/llm-client.js'
import { createMemoryMaintenanceRuntime } from './agent/memory-maintenance.js'
import { setTokenUsageDbPersistenceEnabled } from './agent/token-stats.js'
import { replayMissedMessages } from './agent/replay-missed.js'
import { resolveTargetMetadataMaps } from './agent/resolve-target-meta.js'
import { createDedupEnqueue } from './agent/dedup-enqueue.js'
import { createAgentRuntime } from './agent/runtime.js'
import { renderBotEvent } from './agent/render-event.js'
import { createPersistentTaskRegistry } from './agent/background-task-registry.js'
import { enqueueColdStartBootstrap } from './agent/cold-start-bootstrap.js'
import { createShutdownCoordinator, type ShutdownCoordinator } from './ops/shutdown.js'
import { createAgentStartupLifecycle } from './ops/agent-startup-lifecycle.js'
import { purgeObservabilityData } from './ops/observability-retention.js'
import {
  AGENT_CONTEXT_SURFACE_PATH,
  writeRuntimeAgentContextSurface,
} from './ops/agent-context-surface.js'
import { createAgentTaskScheduler } from './agent/task-scheduler.js'
import { createBotGoalStore } from './agent/goal-store.js'
import { createWorkspaceStateCoordinator } from './agent/workspace-state-coordinator.js'
import {
  createStartupGoalControlGate,
  replayOwnerGoalCommands,
  tryHandleOwnerGoalMessage,
} from './agent/goal-control.js'
import { createAgentActivityReporter } from './agent/activity-surface.js'
import {
  createQqGatewayMessageSender,
  QqGatewayClient,
} from './services/qq-gateway-client.js'
import {
  createDatabaseMailboxWatcher,
  currentMessageHighWater,
  type DatabaseMailboxWatcher,
} from './services/database-mailbox-watcher.js'
import { startAgentEventsServer, type AgentEventsServer } from './services/agent-events-server.js'
import { createRemoteScheduleRuntime } from './services/scheduler-client.js'
import { createGroupMuteInspector } from './messaging/group-mute-inspector.js'

const log = createLogger('APP')

// 仅供 WebAdmin 与破坏性运维命令判断 Bot 是否仍在运行；不再承载产品控制信号。
const BOT_PID_FILE = '.bot.pid'
const SHUTDOWN_TIMEOUT_MS = 30_000
let shutdownCoordinator: ShutdownCoordinator | null = null
let fallbackShutdownPromise: Promise<void> | null = null
let retentionRunner: DailyRetentionRunner | null = null

async function main() {
  log.info(
    {
      groupIds: config.botTargetGroupIds,
      groupPolicies: config.groupPolicies,
    },
    'qq-bot-v2 single-context MVP-2 启动',
  )
  await prisma.$connect()
  setTokenUsageDbPersistenceEnabled(true)
  log.info('数据库已连接')

  // 平台模式下媒体 provider 与队列由独立 media-worker 拥有。
  if (!config.services.enabled) {
    const mediaProvider = buildMediaProvider(config.llm)
    setLlmProvider(mediaProvider)
    log.info(
      {
        defaultProvider: config.llm.defaultProvider,
        defaultModel: config.llm.defaultModel,
      },
      'LLM media provider 已注册',
    )
    jobQueue.start()
  }

  // 3. Agent 自己的 LLM 客户端 (走 default provider/model, 后续可以单独换)
  const llm = createLlmClient()
  const taskScheduler = createAgentTaskScheduler()
  const workspaceStateCoordinator = createWorkspaceStateCoordinator()
  const maintenanceLlm = createLlmClient({
    claudeThinking: { mode: 'disabled' },
  })
  const memoryMaintenance = createMemoryMaintenanceRuntime({
    llm: maintenanceLlm,
    taskScheduler,
    workspaceStateCoordinator,
  })

  // 4. 永续上下文 + 持久化 + 启动恢复
  const ledgerRepo = createAgentLedgerRepo()
  const ledgerLoader = createAgentLedgerLoader({ repo: ledgerRepo })
  const goalStore = createBotGoalStore()
  const loadedLedger = await ledgerLoader.load()
  const context = createAgentContext()
  context.installProjection(loadedLedger.projection.snapshot)
  const hasPersistedLedger = loadedLedger.projection.permanentEntryCount > 0
  if (hasPersistedLedger) {
    log.info({
      checkpointStatus: loadedLedger.checkpointStatus,
      messages: loadedLedger.projection.snapshot.messages.length,
      permanentEntries: loadedLedger.projection.permanentEntryCount,
      mailboxSources: Object.keys(loadedLedger.runtimeState.mailboxCursors).length,
      mailboxContinuitySources: Object.keys(loadedLedger.runtimeState.mailboxContinuity.mailboxes).length,
      goalRevision: loadedLedger.runtimeState.goalRevision,
      lastWakeAt: loadedLedger.runtimeState.lastWakeAt
        ? formatBeijingIso(loadedLedger.runtimeState.lastWakeAt)
        : null,
    }, '从 canonical agent ledger 恢复 AgentContext')
  } else {
    log.info({ checkpointStatus: loadedLedger.checkpointStatus }, 'AgentContext 从空 ledger 启动')
  }

  // 5. 事件队列 + messageRowId 去重 (replay-missed × live event 重叠时去重, 见 dedup-enqueue.ts)
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const persistentTasks = createPersistentTaskRegistry({ path: config.backgroundTaskStatePath })
  for (const task of persistentTasks.interruptedAtStartup) {
    eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: task.id,
      toolName: task.toolName,
      description: task.description,
      elapsedMs: Math.max(0, (task.completedAt?.getTime() ?? Date.now()) - task.startedAt.getTime()),
      ok: false,
      summary: '后台任务因进程重启中断；可查看任务详情或按原参数重新发起。',
    })
  }
  const enqueueDedupedMessageEvent = createDedupEnqueue(eventQueue)
  writeFileSync(BOT_PID_FILE, String(process.pid))
  log.info({ pidFile: BOT_PID_FILE, pid: process.pid }, 'pid_file_written')
  const processOwnerGoalControl = async (
    event: Extract<BotEvent, { type: 'napcat_private_message' }>,
  ): Promise<void> => {
    try {
      const control = await tryHandleOwnerGoalMessage({
        owner: config.owner,
        peerId: event.peerId,
        senderId: event.senderId,
        messageRowId: event.messageRowId,
        renderedText: event.renderedText,
        goalStore,
      })
      if (control.handled) {
        log.info(
          {
            messageRowId: event.messageRowId,
            action: control.command?.action ?? 'invalid',
            ok: control.mutation?.ok ?? false,
            code: control.mutation?.code,
            error: control.error ?? control.mutation?.error,
          },
          'owner_goal_control_processed',
        )
      }
    } catch (error) {
      log.error({ error, messageRowId: event.messageRowId }, 'owner_goal_control_failed_message_still_enqueued')
    }
  }
  const startupGoalControlGate = createStartupGoalControlGate(processOwnerGoalControl)
  const passiveGroupNotificationIds = new Set(
    config.groupPolicies
      .filter((policy) => policy.participation !== 'mentions')
      .map((policy) => policy.id),
  )
  const enqueueMessageEvent = async (event: BotEvent): Promise<boolean> => {
    // mentions 群的普通消息只保存在 messages/inbox；selective/active 群进入 passive
    // notification，但不会打断等待或休息。私聊和明确 @ bot 才是 attention。
    if (
      (event.type === 'napcat_message' || event.type === 'napcat_private_message')
      && !shouldQueueChatEvent(event, passiveGroupNotificationIds)
    ) return false
    if (event.type === 'napcat_private_message') {
      await startupGoalControlGate.submit(event)
    }
    return enqueueDedupedMessageEvent(event)
  }

  let mailboxWatcher: DatabaseMailboxWatcher | null = null
  let agentEventsServer: AgentEventsServer | null = null
  const qqGateway = config.services.enabled
    ? new QqGatewayClient(config.services.qqGatewayUrl)
    : null
  const directQq = config.services.enabled ? null : await import('./bot/core.js')
  const directNapcatModule = config.services.enabled ? null : await import('./bot/napcat.js')
  const directNapcat = directNapcatModule?.napcat
  const remoteMailboxHighWater = config.services.enabled
    ? await currentMessageHighWater()
    : 0

  // 6. 单进程兼容模式仍直接注册 NapCat；平台模式由 qq-gateway 独占连接，
  // Agent Core 从 PostgreSQL mailbox watcher 获取新事实。
  const onMessageReady = async (input: IngestedMessage) => {
    if (input.kind === 'group') {
      await enqueueMessageEvent({
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
      await enqueueMessageEvent({
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
  const napcatLifecycle = config.services.enabled
    ? { initialBackfillDone: Promise.resolve(), drain: async () => undefined }
    : directQq!.registerNapcatHandlers({ onMessageReady })

  if (!config.services.enabled) {
    await directQq!.connectNapcat()
    await napcatLifecycle.initialBackfillDone
    log.info('首次群历史消息补拉完成')
  } else {
    agentEventsServer = await startAgentEventsServer({
      baseUrl: config.services.agentEventsUrl,
      enqueue: (event) => {
        eventQueue.enqueue(event)
      },
      isCommitted: async (event) => {
        const rendered = renderBotEvent(event)
        if (rendered == null) return false
        const canonical = await ledgerRepo.loadCanonicalState()
        return canonical.entries.some((entry) => (
          entry.entryType === 'message'
          && entry.payload.message.role === 'user'
          && entry.payload.message.content === rendered
        ))
      },
    })
    log.info({
      qqGatewayUrl: config.services.qqGatewayUrl,
      agentEventsUrl: config.services.agentEventsUrl,
    }, 'Agent Core 已进入平台服务模式')
  }

  // 8. 启动元数据 (群名) — 用于拼 system prompt
  const targetMetadata = await resolveTargetMetadataMaps({
    napcat: qqGateway
      ? {
          get_group_info: async ({ group_id }) => {
            const result = await qqGateway.groupInfo(group_id)
            return { group_name: result.groupName }
          },
        }
      : directNapcat!,
    groupIds: config.botTargetGroupIds,
  })

  // 9. 关机期间消息回放. 在 connect 之后跑也安全, 因为 enqueueMessageEvent 按
  //    messageRowId 去重 (步骤 5), live 已经先入队的就不会被 replay 重复入队.
  const replayedGoalControls = await replayOwnerGoalCommands({
    owner: config.owner,
    mailboxCursors: loadedLedger.runtimeState.mailboxCursors,
    legacyLastWakeAt: loadedLedger.runtimeState.lastWakeAt,
    goalStore,
  })
  if (replayedGoalControls.matched > 0) {
    log.info(replayedGoalControls, 'owner goal control replay 完成')
  }
  await startupGoalControlGate.finishReplay()
  const replayResult = await replayMissedMessages({
    mailboxCursors: loadedLedger.runtimeState.mailboxCursors,
    legacyLastWakeAt: loadedLedger.runtimeState.lastWakeAt,
  }, {
    enqueueMessageEvent,
    selfNumber: config.selfNumber,
    groupIds: config.botTargetGroupIds,
    passiveGroupIds: [...passiveGroupNotificationIds],
  })
  log.info({ enqueued: replayResult.enqueued }, 'replay-missed 完成')

  if (config.services.enabled) {
    mailboxWatcher = createDatabaseMailboxWatcher({
      startAfterRowId: remoteMailboxHighWater,
      pollMs: config.services.mailboxPollMs,
      selfNumber: config.selfNumber,
      groupPolicies: config.groupPolicies,
      enqueue: async (event) => {
        await enqueueMessageEvent(event)
      },
    })
    mailboxWatcher.start()
  }

  if (enqueueColdStartBootstrap(eventQueue, hasPersistedLedger)) {
    log.info('无持久 ledger 且事件队列为空，已注入冷启动 bootstrap')
  }

  // 10. 工具集 + bot system prompt (启动后定型, 进程内不变)
  const activityReporter = createAgentActivityReporter()
  const sender = qqGateway ? createQqGatewayMessageSender(qqGateway) : messageSender
  const groupMuteInspector = qqGateway
    ? createGroupMuteInspector({
        selfNumber: config.selfNumber,
        loadGroupShutList: (groupId) => qqGateway.groupShutList(groupId),
      })
    : undefined
  const scheduleRuntime = config.services.enabled
    ? createRemoteScheduleRuntime(config.services.schedulerUrl)
    : undefined
  const runtime = createAgentRuntime({
    context,
    eventQueue,
    llm,
    ledgerRepo,
    ledgerLoader,
    initialLedgerHeadEntryId: loadedLedger.runtimeState.ledgerHeadEntryId,
    sender,
    groupMuteInspector,
    loadFriends: async () => qqGateway
      ? qqGateway.friends()
      : (await directNapcat!.get_friend_list()).map((friend) => ({
          userId: friend.user_id,
          nickname: friend.nickname,
          remark: friend.remark,
        })),
    loadGroups: async () => qqGateway
      ? qqGateway.groups()
      : (await directNapcat!.get_group_list()).map((group) => ({
          groupId: group.group_id,
          groupName: group.group_name,
          groupRemark: group.group_remark,
          memberCount: group.member_count,
          maxMemberCount: group.max_member_count,
        })),
    selfNumber: config.selfNumber,
    metadata: targetMetadata,
    groupPolicies: config.groupPolicies,
    toolCallLogPath: config.toolCallLogPath,
    toolAuditMode: config.toolAuditMode,
    toolAuditDbEnabled: config.toolAuditDbEnabled,
    owner: config.owner,
    eventDebounceMs: config.eventDebounceMs,
    initialMailboxCursors: loadedLedger.runtimeState.mailboxCursors,
    initialInboxReadCursors: loadedLedger.runtimeState.inboxReadCursors,
    initialMailboxContinuity: loadedLedger.runtimeState.mailboxContinuity,
    initialLastWakeAt: loadedLedger.runtimeState.lastWakeAt,
    initialGoalRevision: loadedLedger.runtimeState.goalRevision,
    goalStore,
    taskScheduler,
    memoryMaintenance,
    workspaceStateCoordinator,
    taskRegistry: persistentTasks.registry,
    scheduleStatePath: config.scheduleStatePath,
    scheduleRuntime,
    approvalStatePath: config.approvalStatePath,
    approvalMode: config.approvalMode,
    mcpConfigPath: config.mcpConfigPath,
    mcpSchemaSnapshotDir: config.mcpSchemaSnapshotDir,
    activityReporter,
    onEventsCommitted: (events) => {
      agentEventsServer?.markCommitted(events)
    },
  })
  try {
    const provider = config.llm.defaultProvider
    if (provider !== CLAUDE_CODE_PROVIDER_NAME && provider !== OPENAI_AGENT_PROVIDER_NAME) {
      throw new Error(`unsupported context surface provider: ${provider}`)
    }
    const surface = await writeRuntimeAgentContextSurface({
      path: AGENT_CONTEXT_SURFACE_PATH,
      provider,
      model: config.llm.defaultModel,
      contextWindowTokens: config.llm.contextWindowTokensByModel[config.llm.defaultModel]!,
      systemPrompt: runtime.systemPrompt,
      tools: runtime.tools.list(),
    })
    log.info(
      {
        path: AGENT_CONTEXT_SURFACE_PATH,
        schemaVersion: surface.schemaVersion,
        generatedAt: surface.generatedAt,
      },
      'context surface 已写入',
    )
  } catch (error) {
    log.warn(
      { error, path: AGENT_CONTEXT_SURFACE_PATH },
      'context surface 写入失败',
    )
  }

  // 10.5 把 system prompt 写到文件, 方便调试查看
  {
    const now = new Date()
    const beijingTime = formatBeijingDateTime(now)
    const header = `=== System Prompt (${beijingTime} 北京时间) ===\n\n`
    mkdirSync('logs', { recursive: true })
    writeFileSync('logs/system-prompt.txt', header + runtime.systemPrompt + '\n', 'utf-8')
    log.info('system prompt 已写入 logs/system-prompt.txt')
  }

  // 11. 进入主循环
  log.info('BotLoopAgent 进入主循环')
  const agentLifecycle = createAgentStartupLifecycle({
    startBackgroundServices: () => runtime.startBackgroundServices(),
    startAgent: () => runtime.agent.start(),
    stopAgent: () => runtime.agent.stop(),
  })
  retentionRunner = createDailyRetentionRunner({ run: runRetentionMaintenance })
  shutdownCoordinator = createShutdownCoordinator({
    disconnectIngress: config.services.enabled
      ? () => mailboxWatcher?.stop()
      : directNapcatModule!.disconnectNapcatForShutdown,
    stopAgent: agentLifecycle.stopAgent,
    awaitAgent: agentLifecycle.awaitAgent,
    drainIngress: () => napcatLifecycle.drain(),
    stopJobs: async () => {
      await retentionRunner?.stop()
      if (!config.services.enabled) jobQueue.stop()
      await runtime.stopBackgroundServices()
      await taskScheduler.drain()
      await agentEventsServer?.close()
      removePidFile()
    },
    saveFinal: () => runtime.agent.flush(),
    disconnectDb: () => prisma.$disconnect(),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    onPhaseError: (error) => {
      log.error(error, 'shutdown_phase_failed')
    },
  })
  retentionRunner.start()
  await agentLifecycle.start()
}

async function runRetentionMaintenance(): Promise<void> {
  const errors: unknown[] = []
  try {
    await purgeOldData()
  } catch (error) {
    errors.push(error)
  }
  try {
    await purgeObservabilityData({
      retentionDays: config.observabilityRetentionDays,
      ndjsonPaths: [
        config.tokenUsageLogPath,
        config.toolCallLogPath,
        config.fetchLogPath,
      ],
    })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'retention maintenance failed')
}

function removePidFile(): void {
  try {
    unlinkSync(BOT_PID_FILE)
  } catch {
    // 文件可能不存在（启动失败或已由运维清理）。
  }
}

function shutdownBeforeRuntimeReady(): Promise<void> {
  fallbackShutdownPromise ??= (async () => {
    await retentionRunner?.stop()
    if (config.services.enabled) {
      // 独立服务由 platform supervisor 关闭；Agent Core 不拥有它们的连接。
    } else {
      const { disconnectNapcatForShutdown } = await import('./bot/napcat.js')
      disconnectNapcatForShutdown()
      jobQueue.stop()
    }
    removePidFile()
    await prisma.$disconnect()
  })()
  return fallbackShutdownPromise
}

async function requestShutdown(reason: string): Promise<void> {
  log.info({ reason }, 'Shutting down...')
  if (!shutdownCoordinator) {
    await shutdownBeforeRuntimeReady()
    return
  }
  const result = await shutdownCoordinator.shutdown(reason)
  if (!result.ok) process.exitCode = 1
}

process.on('SIGINT', () => void requestShutdown('SIGINT'))
process.on('SIGTERM', () => void requestShutdown('SIGTERM'))

main().catch(async (err) => {
  log.fatal({ err }, 'Failed to start')
  process.exitCode = 1
  await requestShutdown('startup_error')
})
