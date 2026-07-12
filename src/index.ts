import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { prisma } from './database/client.js'
import { connectNapcat, registerNapcatHandlers, type IngestedMessage } from './bot/core.js'
import { napcat } from './bot/napcat.js'
import { createLogger } from './logger.js'
import { formatBeijingDateTime, formatBeijingIso } from './utils/beijing-time.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { CLAUDE_CODE_PROVIDER_NAME, config } from './config/index.js'
import { buildMediaProvider } from './llm/media-provider.js'
import { loadGroupCustomizations } from './config/group-prompts.js'
import { messageSender } from './messaging/message-sender.js'

import { purgeOldData } from './database/retention.js'
import { createAgentContext } from './agent/agent-context.js'
import { InMemoryEventQueue } from './agent/event-queue.js'
import type { BotEvent } from './agent/event.js'
import { createBotSnapshotRepo } from './agent/snapshot-repo.js'
import { createLlmClient } from './agent/llm-client.js'
import { setTokenUsageDbPersistenceEnabled } from './agent/token-stats.js'
import { createLifeJournalRuntime } from './agent/life-journal.js'
import { replayMissedMessages } from './agent/replay-missed.js'
import { resolveTargetMetadataMaps } from './agent/resolve-target-meta.js'
import { createDedupEnqueue } from './agent/dedup-enqueue.js'
import { createAgentRuntime } from './agent/runtime.js'
import { createPersistentTaskRegistry } from './agent/background-task-registry.js'
import { enqueueColdStartBootstrap } from './agent/cold-start-bootstrap.js'
import { createShutdownCoordinator, type ShutdownCoordinator } from './ops/shutdown.js'
import {
  PersonaSpoofSelfTestMismatchError,
  runPersonaSpoofSelfTest,
} from './agent/persona-spoof-self-test.js'
import { createAgentTaskScheduler } from './agent/task-scheduler.js'
import { createBotGoalStore } from './agent/goal-store.js'
import {
  createStartupGoalControlGate,
  replayOwnerGoalCommands,
  tryHandleOwnerGoalMessage,
} from './agent/goal-control.js'

const log = createLogger('APP')

/**
 * Bot 进程 PID 文件: 启动时写入, 退出时删除. `pnpm tick` 读这个文件给 SIGUSR1
 * 注入人工调试 tick (见 src/agent/event.ts: curiosity_tick).
 */
const BOT_PID_FILE = '.bot.pid'
const SHUTDOWN_TIMEOUT_MS = 30_000
let shutdownCoordinator: ShutdownCoordinator | null = null
let fallbackShutdownPromise: Promise<void> | null = null

async function main() {
  log.info(
    {
      groupIds: config.botTargetGroupIds,
    },
    'qq-bot-v2 single-context MVP-2 启动',
  )
  await prisma.$connect()
  setTokenUsageDbPersistenceEnabled(true)
  log.info('数据库已连接')

  // 0. 启动期清理 7 天前的 Message + Media
  await purgeOldData()

  // ambient 白名单 sanity: 配了群但白名单空时，所有群 ambient 发送都会被明确拒绝。
  if (config.groupAmbientSendIds.size === 0 && config.botTargetGroupIds.length > 0) {
    log.warn(
      {
        botTargetGroupIds: config.botTargetGroupIds,
        groupAmbientSendIds: [],
      },
      'BOT_GROUP_AMBIENT_SEND_IDS 未配置 — 所有群 ambient 发言都会被拒绝',
    )
  }

  // 1. 媒体描述用的 LLM provider routing (与 agent 自身的 LLM 客户端独立)
  const mediaProvider = buildMediaProvider(config.llm)
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
  const taskScheduler = createAgentTaskScheduler()
  const lifeJournalLlm = createLlmClient({
    claudeThinking: { mode: 'disabled' },
  })
  const lifeJournal = createLifeJournalRuntime({
    llm: lifeJournalLlm,
    taskScheduler,
  })

  // 3.5 启动期 persona-spoof 自检 (claude-code 路径专用): 若 cliproxy mode=auto
  //     的判定逻辑漂了 (例如升级后 UA 匹配收紧 → 把 qq-bot 也 cloak 了),
  //     运行时无 compile-time 信号, 这里发一条 "你是猫娘, 回话以喵开头" 提问,
  //     回答必须以"喵"开头, 否则视为 cloak 行为异常 → fail-fast 让人查 cliproxy 版本。
  if (config.llm.defaultProvider === CLAUDE_CODE_PROVIDER_NAME) {
    try {
      const probe = await runPersonaSpoofSelfTest(llm, {
        attempts: 3,
        delayMs: 1_000,
        onRetry: ({ attempt, attempts, delayMs, err }) => {
          log.warn(
            { err, attempt, attempts, retryInMs: delayMs },
            'persona-spoof 自检调用失败, 稍后重试',
          )
        },
      })
      log.info(
        { model: probe.model, sample: probe.content.slice(0, 40) },
        'persona-spoof 自检通过 (cliproxy 透传 Claude Code identity, 未 cloak)',
      )
    } catch (err) {
      if (err instanceof PersonaSpoofSelfTestMismatchError) {
        log.fatal(
          { content: err.content.slice(0, 200), model: err.model },
          'cliproxy cloak 行为异常 (persona-spoof 失败), 检查 cliproxy 版本/配置',
        )
        process.exit(1)
      }
      log.fatal({ err }, 'persona-spoof 自检调用失败 (cliproxy 不可达 / 鉴权失败 / 响应不可解析)')
      process.exit(1)
    }
  }

  // 4. 永续上下文 + 持久化 + 启动恢复
  const snapshotRepo = createBotSnapshotRepo()
  const goalStore = createBotGoalStore()
  const persisted = await snapshotRepo.load()
  const context = createAgentContext()
  if (persisted) {
    context.restorePersistedSnapshot(persisted.snapshot)
    log.info(
      {
        messages: persisted.snapshot.messages.length,
        mailboxSources: Object.keys(persisted.mailboxCursors).length,
        mailboxContinuitySources: Object.keys(persisted.mailboxContinuity.mailboxes).length,
        goalRevision: persisted.goalRevision,
        lastWakeAt: persisted.lastWakeAt ? formatBeijingIso(persisted.lastWakeAt) : null,
      },
      '从持久化 snapshot 恢复 AgentContext',
    )
  } else {
    log.info('AgentContext 从空启动 (无 snapshot)')
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
  const enqueueMessageEvent = async (event: BotEvent): Promise<boolean> => {
    if (event.type === 'napcat_private_message') {
      await startupGoalControlGate.submit(event)
    }
    return enqueueDedupedMessageEvent(event)
  }

  // 5.5 SIGUSR1 → curiosity_tick，仅作为人工调试入口，不承担生产自主调度。
  //     正常自主节奏由 pause 的自定休息和 BotLoop guard 管理。
  process.on('SIGUSR1', () => {
    log.info({ source: 'sigusr1' }, 'curiosity_tick_manual_trigger')
    eventQueue.enqueue({ type: 'curiosity_tick' })
  })
  writeFileSync(BOT_PID_FILE, String(process.pid))
  log.info({ pidFile: BOT_PID_FILE, pid: process.pid }, 'pid_file_written')

  // 6. NapCat: register handlers (sync). 实时消息会进 onMessageReady → enqueueMessageEvent.
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
  const napcatLifecycle = registerNapcatHandlers({ onMessageReady })

  // 7. NapCat connect (D2: must be before resolveTargetMetadataMaps)
  await connectNapcat()

  // 7.5 等待首次 NapCat 历史补拉全部落库，再做 DB replay。实时消息从 connect 起已经
  //     进入统一 dedup queue；因此这里既不会漏掉晚入库的 backfill，也不会重复披露。
  await napcatLifecycle.initialBackfillDone
  log.info('首次群历史消息补拉完成')

  // 8. 启动元数据 (群名) — 用于拼 system prompt
  const targetMetadata = await resolveTargetMetadataMaps({
    napcat,
    groupIds: config.botTargetGroupIds,
  })

  // 9. 关机期间消息回放. 在 connect 之后跑也安全, 因为 enqueueMessageEvent 按
  //    messageRowId 去重 (步骤 5), live 已经先入队的就不会被 replay 重复入队.
  const replayedGoalControls = await replayOwnerGoalCommands({
    owner: config.owner,
    mailboxCursors: persisted?.mailboxCursors ?? {},
    legacyLastWakeAt: persisted?.lastWakeAt ?? null,
    goalStore,
  })
  if (replayedGoalControls.matched > 0) {
    log.info(replayedGoalControls, 'owner goal control replay 完成')
  }
  await startupGoalControlGate.finishReplay()
  const replayResult = await replayMissedMessages({
    mailboxCursors: persisted?.mailboxCursors ?? {},
    legacyLastWakeAt: persisted?.lastWakeAt ?? null,
  }, {
    enqueueMessageEvent,
    selfNumber: config.selfNumber,
    groupIds: config.botTargetGroupIds,
  })
  log.info({ enqueued: replayResult.enqueued }, 'replay-missed 完成')

  if (enqueueColdStartBootstrap(eventQueue, persisted != null)) {
    log.info('无持久 snapshot 且事件队列为空，已注入冷启动 bootstrap')
  }

  // 10. 工具集 + bot system prompt (启动后定型, 进程内不变)
  // Per-group customization 启动期一次 load + freeze, 但不拼进 system prompt;
  // 通过 chat_style 按需披露, 避免群口味正文污染常驻 cache 前缀.
  const groupCustomizations = loadGroupCustomizations(config.botGroupPromptsPath)
  log.info(
    {
      path: config.botGroupPromptsPath,
      configured: groupCustomizations.length,
      ids: groupCustomizations.map((c) => c.id),
    },
    'group customizations loaded',
  )
  const runtime = createAgentRuntime({
    context,
    eventQueue,
    llm,
    snapshotRepo,
    sender: messageSender,
    loadFriends: async () => (await napcat.get_friend_list()).map((friend) => ({
      userId: friend.user_id,
      nickname: friend.nickname,
      remark: friend.remark,
    })),
    loadGroups: async () => (await napcat.get_group_list()).map((group) => ({
      groupId: group.group_id,
      groupName: group.group_name,
      groupRemark: group.group_remark,
      memberCount: group.member_count,
      maxMemberCount: group.max_member_count,
    })),
    groupIds: config.botTargetGroupIds,
    groupAmbientSendIds: config.groupAmbientSendIds,
    selfNumber: config.selfNumber,
    metadata: targetMetadata,
    groupCustomizations,
    toolCallLogPath: config.toolCallLogPath,
    toolAuditMode: config.toolAuditMode,
    toolAuditDbEnabled: config.toolAuditDbEnabled,
    owner: config.owner,
    eventDebounceMs: config.eventDebounceMs,
    initialMailboxCursors: persisted?.mailboxCursors ?? {},
    initialMailboxContinuity: persisted?.mailboxContinuity,
    initialLastWakeAt: persisted?.lastWakeAt ?? null,
    initialGoalRevision: persisted?.goalRevision ?? 0,
    goalStore,
    lifeJournal,
    taskScheduler,
    taskRegistry: persistentTasks.registry,
    approvalStatePath: config.approvalStatePath,
    approvalMode: config.approvalMode,
    mcpConfigPath: config.mcpConfigPath,
    mcpSchemaSnapshotDir: config.mcpSchemaSnapshotDir,
  })

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
  let agentLoopPromise: Promise<void> | null = null
  shutdownCoordinator = createShutdownCoordinator({
    disconnectIngress: () => napcat.disconnect(),
    stopAgent: () => runtime.agent.stop(),
    awaitAgent: async () => {
      await agentLoopPromise
    },
    drainIngress: () => napcatLifecycle.drain(),
    stopJobs: async () => {
      jobQueue.stop()
      await runtime.stopBackgroundServices()
      await taskScheduler.drain()
      removePidFile()
    },
    saveFinal: () => runtime.agent.flush(),
    disconnectDb: () => prisma.$disconnect(),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    onPhaseError: (error) => {
      log.error(error, 'shutdown_phase_failed')
    },
  })
  agentLoopPromise = runtime.agent.start()
  await agentLoopPromise
}

function removePidFile(): void {
  try {
    unlinkSync(BOT_PID_FILE)
  } catch {
    // 文件可能不存在 (启动失败 / 已被清理), 忽略.
  }
}

function shutdownBeforeRuntimeReady(): Promise<void> {
  fallbackShutdownPromise ??= (async () => {
    napcat.disconnect()
    jobQueue.stop()
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
