import {
  createBotLoopAgent,
  type BotLoopAgent,
  type BotLoopLifeJournal,
} from './bot-loop-agent.js'
import { buildBotSystemPrompt } from './bot-system-prompt.js'
import {
  createInMemoryTaskRegistry,
  type BackgroundTaskRegistry,
} from './background-task-registry.js'
import { renderBotEvent } from './render-event.js'
import { createSendTargetPolicy } from './send-target-policy.js'
import { createDeferredToolExecutor, type ToolExecutor } from './tool.js'
import {
  createGenerateImageTaskLogHook,
  createSendMessageAiToneHook,
  createSendMessageSafetyGuard,
} from './tool-policy-hooks.js'
import { createOwnerApprovalHook, type ApprovalMode } from './approval-policy.js'
import { buildBotToolManifest, type BotOptionalTools } from './tools/index.js'
import type { AgentContext } from './agent-context.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { AgentLedgerLoader } from './agent-ledger-loader.js'
import type { AgentLedgerRepo } from './agent-ledger-repo.js'
import type { MailboxCursors } from './mailbox.js'
import type { InboxReadCursors } from './inbox-read-cursors.js'
import type { MailboxContinuityState } from './mailbox-continuity.js'
import type { TargetMetadataMaps } from './resolve-target-meta.js'
import { groupPolicyAllowsAmbient, type GroupPolicy } from '../config/group-policies.js'
import type { BotOwner } from '../config/index.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  findApprovalEvidenceMessage,
  findMemoryEvidenceRows,
  findObservedQqIdentityRows,
  isGroupMessageMentioningUser,
} from '../database/messages.js'
import type { TaskScheduler } from './task-scheduler.js'
import type { QqDirectoryFriend, QqDirectoryGroup } from './tools/qq-directory.js'
import {
  createScheduleRuntime,
  ScheduleRuntimeError,
  type ScheduleRuntime,
  type ScheduleRuntimeLogEntry,
} from './schedule-runtime.js'
import {
  createInMemoryScheduleStore,
  createPersistentScheduleStore,
} from './schedule-store.js'
import { createApprovalManager, type ApprovalManager } from './approval-manager.js'
import {
  createMcpManagerFromConfigFile,
  type McpManager,
} from './mcp-manager.js'
import type { GoalStore } from './goal-store.js'
import type { MemoryMaintenanceRuntime } from './memory-maintenance.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'
import { createLogger } from '../logger.js'
import { createQqConversationController } from './tools/qq-conversation.js'
import { findPendingMailboxThroughRowId } from './mailbox-handled.js'

const scheduleLog = createLogger('SCHEDULE')

interface ScheduleOperationsLogger {
  error(...args: unknown[]): void
}

export function createScheduleRuntimeLogHandler(
  logger: ScheduleOperationsLogger = scheduleLog,
): (entry: ScheduleRuntimeLogEntry) => void {
  return (entry) => {
    logger.error({
      event: entry.event,
      scheduleId: entry.scheduleId,
      err: entry.error,
    }, 'schedule_runtime_failed')
  }
}

export interface AgentRuntimeInput {
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  ledgerRepo: AgentLedgerRepo
  ledgerLoader: AgentLedgerLoader
  initialLedgerHeadEntryId?: bigint | null
  sender: MessageSender
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
  selfNumber: number
  metadata: TargetMetadataMaps
  groupPolicies: readonly GroupPolicy[]
  toolCallLogPath: string
  toolAuditMode?: 'all' | 'side_effects' | 'off'
  toolAuditDbEnabled?: boolean
  owner: BotOwner | null
  eventDebounceMs?: number
  initialMailboxCursors?: Readonly<MailboxCursors>
  initialInboxReadCursors?: Readonly<InboxReadCursors>
  initialMailboxContinuity?: MailboxContinuityState
  initialLastWakeAt?: Date | null
  initialGoalRevision?: number
  goalStore?: GoalStore
  lifeJournal?: BotLoopLifeJournal
  taskScheduler?: TaskScheduler
  memoryMaintenance?: MemoryMaintenanceRuntime
  workspaceDir?: string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
  taskRegistry?: BackgroundTaskRegistry
  scheduleRuntime?: ScheduleRuntime
  scheduleStatePath?: string
  scheduleLogger?: (entry: ScheduleRuntimeLogEntry) => void
  approvalManager?: ApprovalManager
  approvalStatePath?: string
  approvalMode?: ApprovalMode
  mcpManager?: McpManager
  mcpConfigPath?: string
  mcpSchemaSnapshotDir?: string
  /** 测试或嵌入方显式替换/关闭配置驱动的可选工具；生产默认按 config 自动发现。 */
  optionalTools?: BotOptionalTools
}

export interface AgentRuntime {
  tools: ToolExecutor
  systemPrompt: string
  agent: BotLoopAgent
  startBackgroundServices(): Promise<void>
  stopBackgroundServices(): Promise<void>
}

export function createAgentRuntime(input: AgentRuntimeInput): AgentRuntime {
  let activeToolCapabilities = [...input.context.getSnapshot().activeToolCapabilities]
  let qqConversationFocus = input.context.getSnapshot().qqConversationFocus
  let inboxReadCursors: InboxReadCursors = { ...input.initialInboxReadCursors }
  const groupIds = input.groupPolicies.map((policy) => policy.id)
  const groupAmbientSendIds = new Set(
    input.groupPolicies
      .filter(groupPolicyAllowsAmbient)
      .map((policy) => policy.id),
  )
  const groupParticipations = new Map(
    input.groupPolicies.map((policy) => [policy.id, policy.participation]),
  )
  const taskRegistry = input.taskRegistry ?? createInMemoryTaskRegistry()
  const scheduleRuntime = input.scheduleRuntime ?? createScheduleRuntime({
    store: input.scheduleStatePath
      ? createPersistentScheduleStore(input.scheduleStatePath)
      : createInMemoryScheduleStore(),
    eventQueue: input.eventQueue,
    logger: input.scheduleLogger ?? createScheduleRuntimeLogHandler(),
  })
  const approvalManager = input.approvalManager ?? createApprovalManager({
    path: input.approvalStatePath ?? 'data/agent-workspace/runtime/approvals.json',
    owner: input.owner,
    loadEvidence: findApprovalEvidenceMessage,
  })
  const mcpManager = input.mcpManager ?? (input.mcpConfigPath
    ? createMcpManagerFromConfigFile({
        path: input.mcpConfigPath,
        snapshotDir: input.mcpSchemaSnapshotDir,
      })
    : undefined)
  const targetPolicy = createSendTargetPolicy({
    groupIds,
    groupAmbientSendIds,
    loadFriendIds: async () => (await input.loadFriends()).map((friend) => friend.userId),
    isGroupReplyToSelf: ({ groupId, messageId }) => isGroupMessageMentioningUser(
      groupId,
      messageId,
      input.selfNumber,
    ),
  })
  const conversations = createQqConversationController({
    state: {
      get: () => qqConversationFocus,
      set: (focus) => {
        qqConversationFocus = focus == null
          ? null
          : focus.type === 'group'
            ? { type: 'group', groupId: focus.groupId }
            : { type: 'private', userId: focus.userId }
      },
    },
    groupIds,
    loadGroups: input.loadGroups,
    loadFriends: input.loadFriends,
  })
  const getCurrentQqTarget = () => conversations.getCurrent()
  const sendMessageSafetyGuard = createSendMessageSafetyGuard({
    getCurrentTarget: getCurrentQqTarget,
    hasPendingPrivateMailbox: (userId) => findPendingMailboxThroughRowId(
      input.context.getSnapshot().messages,
      `qq_private:${userId}`,
    ) != null,
  })
  const tools = createDeferredToolExecutor({
    ...buildBotToolManifest({
      sender: input.sender,
      targetPolicy,
      conversations,
      taskRegistry,
      taskScheduler: input.taskScheduler,
      scheduleRuntime,
      llm: input.llm,
      approvalManager,
      mcpManager,
      goalStore: input.goalStore,
      memoryMaintenance: input.memoryMaintenance,
      workspaceDir: input.workspaceDir,
      workspaceStateCoordinator: input.workspaceStateCoordinator,
      optionalTools: input.optionalTools,
      groupIds,
      selfNumber: input.selfNumber,
      getInboxReadCursors: () => inboxReadCursors,
      metadata: input.metadata,
      groupPolicies: input.groupPolicies,
      qqDirectory: {
        groupIds,
        loadFriends: input.loadFriends,
        loadGroups: input.loadGroups,
        loadObservedIdentity: findObservedQqIdentityRows,
      },
      loadMemorySourceEvidence: findMemoryEvidenceRows,
      ownerId: input.owner == null ? undefined : String(input.owner.qq),
    }),
    activeCapabilities: {
      list: () => [...activeToolCapabilities],
      activate: (capability) => {
        if (!activeToolCapabilities.includes(capability)) activeToolCapabilities.push(capability)
      },
      deactivate: (capability) => {
        activeToolCapabilities = activeToolCapabilities.filter((item) => item !== capability)
      },
    },
    trace: {
      path: input.toolCallLogPath,
      mode: input.toolAuditMode ?? 'side_effects',
      persistToDb: input.toolAuditDbEnabled ?? false,
    },
    hooks: {
      beforeTool: [
        createOwnerApprovalHook(approvalManager, (toolName, args) => (
          toolName === 'mcp' ? mcpManager?.approvalRequirementForArgs(args) ?? null : null
        ), input.approvalMode ?? 'thin'),
        sendMessageSafetyGuard.beforeTool,
        createSendMessageAiToneHook({ getCurrentTarget: getCurrentQqTarget }),
      ],
      afterTool: [sendMessageSafetyGuard.afterTool, createGenerateImageTaskLogHook()],
    },
  })

  const systemPrompt = buildBotSystemPrompt({
    groupIds,
    metadata: input.metadata,
    selfNumber: input.selfNumber,
    owner: input.owner,
  })

  const agent = createBotLoopAgent({
    systemPrompt,
    context: input.context,
    eventQueue: input.eventQueue,
    llm: input.llm,
    tools,
    ledgerRepo: input.ledgerRepo,
    ledgerLoader: input.ledgerLoader,
    initialLedgerHeadEntryId: input.initialLedgerHeadEntryId,
    getActiveToolCapabilities: () => activeToolCapabilities,
    syncActiveToolCapabilities: (capabilities) => {
      activeToolCapabilities = [...capabilities]
    },
    getQqConversationFocus: () => qqConversationFocus,
    syncQqConversationFocus: (focus) => {
      qqConversationFocus = focus
    },
    initialMailboxCursors: input.initialMailboxCursors ?? {},
    initialInboxReadCursors: input.initialInboxReadCursors ?? {},
    syncInboxReadCursors: (cursors) => {
      inboxReadCursors = { ...cursors }
    },
    initialMailboxContinuity: input.initialMailboxContinuity,
    initialLastWakeAt: input.initialLastWakeAt ?? null,
    initialGoalRevision: input.initialGoalRevision ?? 0,
    goalStore: input.goalStore,
    renderEvent: renderBotEvent,
    eventDebounceMs: input.eventDebounceMs,
    groupParticipations,
    lifeJournal: input.lifeJournal,
  })

  let backgroundStartPromise: Promise<void> | null = null
  let backgroundStopPromise: Promise<void> | null = null
  let backgroundStopRequested = false

  return {
    tools,
    systemPrompt,
    agent,
    startBackgroundServices() {
      if (backgroundStopRequested) {
        return Promise.reject(
          new ScheduleRuntimeError('stopped', 'Background services have stopped'),
        )
      }
      if (backgroundStartPromise) return backgroundStartPromise
      const startAttempt = scheduleRuntime.start()
      backgroundStartPromise = startAttempt.catch((error: unknown) => {
        backgroundStartPromise = null
        if (input.scheduleStatePath) {
          throw new Error(
            `Failed to start schedule runtime from ${JSON.stringify(input.scheduleStatePath)}`,
            { cause: error },
          )
        }
        throw error
      })
      return backgroundStartPromise
    },
    stopBackgroundServices() {
      backgroundStopRequested = true
      backgroundStopPromise ??= (async () => {
        const errors: unknown[] = []
        try {
          await scheduleRuntime.stop()
        } catch (error) {
          errors.push(error)
        }
        try {
          await mcpManager?.closeAll()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Failed to stop Agent background services')
        }
      })()
      return backgroundStopPromise
    },
  }
}
