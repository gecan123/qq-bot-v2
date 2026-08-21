import {
  createBotLoopAgent,
  type BotLoopAgent,
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
  createSendMessageSafetyGuard,
  createSendMessageWorkCommitmentHook,
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
import { createMessageDelivery, type MessageDelivery } from '../messaging/message-delivery.js'
import { createQqDeliveryAdapter } from '../messaging/qq-delivery-adapter.js'
import type { ConversationSendPolicy } from './conversation-send-policy.js'
import { conversationKey } from '../chat/conversation.js'
import {
  findApprovalEvidenceMessage,
  findMemoryEvidenceRows,
  findObservedQqIdentityRows,
  isConversationMessageMentioningUser,
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
import {
  createInMemoryScheduleOccurrenceStore,
  createPersistentScheduleOccurrenceStore,
} from './schedule-occurrence-store.js'
import { createApprovalManager, type ApprovalManager } from './approval-manager.js'
import {
  createMcpManagerFromConfigFile,
  type McpManager,
} from './mcp-manager.js'
import type { GoalStore } from './goal-store.js'
import { createGoalCompletionJudge } from './goal-completion-judge.js'
import type { MemoryMaintenanceRuntime } from './memory-maintenance.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'
import { createLogger } from '../logger.js'
import { createConversationController, type ConversationSummary } from './tools/conversation.js'
import type { ParticipantRef } from '../chat/conversation.js'
import { findPendingMailboxThroughRowId } from './mailbox-handled.js'
import {
  createActivityTrackingToolExecutor,
  type AgentActivityReporter,
} from './activity-surface.js'
import type { GroupMuteInspector } from '../messaging/group-mute-inspector.js'
import { createAgentStateAdvisor } from './agent-state-advisor.js'

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
  delivery?: MessageDelivery
  sendPolicy?: ConversationSendPolicy
  groupMuteInspector?: GroupMuteInspector
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
  loadAdditionalConversations?: () => Promise<readonly ConversationSummary[]>
  selfExternalIds?: Partial<Record<'qq' | 'feishu', string>>
  ownerIdentities?: readonly ParticipantRef[]
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
  /** 可丢弃的实时观察面；写入失败不得影响 Agent 行为。 */
  activityReporter?: AgentActivityReporter
  /** 平台事件写入 canonical ledger 后的确认钩子。 */
  onEventsCommitted?: (events: readonly BotEvent[]) => Promise<void> | void
}

export interface AgentRuntime {
  tools: ToolExecutor
  systemPrompt: string
  agent: BotLoopAgent
  startBackgroundServices(): Promise<void>
  stopBackgroundServices(): Promise<void>
}

export function createAgentRuntime(input: AgentRuntimeInput): AgentRuntime {
  let conversationFocus = input.context.getSnapshot().conversationFocus
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
    occurrenceStore: input.scheduleStatePath
      ? createPersistentScheduleOccurrenceStore(`${input.scheduleStatePath}.occurrences`)
      : createInMemoryScheduleOccurrenceStore(),
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
  const goalCompletionJudge = input.goalStore
    ? createGoalCompletionJudge({
        llm: input.llm,
        getMessages: () => input.context.getSnapshot().messages,
      })
    : undefined
  const qqTargetPolicy = createSendTargetPolicy({
    groupIds,
    groupAmbientSendIds,
    loadFriendIds: async () => (await input.loadFriends()).map((friend) => friend.userId),
    isGroupReplyToSelf: ({ groupId, messageId }) => isConversationMessageMentioningUser(
      {
        platform: 'qq',
        accountId: String(input.selfNumber),
        kind: 'group',
        externalId: String(groupId),
      },
      String(messageId),
      String(input.selfNumber),
    ),
  })
  const targetPolicy: ConversationSendPolicy = input.sendPolicy ?? {
    async authorize(request) {
      if (request.target.platform === 'feishu') {
        const available = await input.loadAdditionalConversations?.() ?? []
        return available.some((item) => conversationKey(item.target) === conversationKey(request.target))
          ? { allowed: true }
          : { allowed: false, error: 'Feishu conversation is not available' }
      }
      if (request.target.platform !== 'qq') {
        return { allowed: false, error: `platform=${request.target.platform} is not configured for sending` }
      }
      const externalId = Number(request.target.externalId)
      if (!Number.isSafeInteger(externalId) || externalId <= 0) {
        return { allowed: false, error: 'QQ target id must be a positive integer' }
      }
      return qqTargetPolicy.authorize({
        target: request.target.kind === 'group'
          ? { type: 'group', groupId: externalId }
          : { type: 'private', userId: externalId },
        mode: request.mode,
        replyToMessageId: request.replyToExternalId == null
          ? undefined
          : Number(request.replyToExternalId),
      })
    },
  }
  const delivery = input.delivery
    ?? createMessageDelivery([createQqDeliveryAdapter(input.sender)])
  const conversations = createConversationController({
    state: {
      get: () => conversationFocus,
      set: (focus) => {
        conversationFocus = focus == null ? null : { ...focus }
      },
    },
    loadConversations: async () => [
      ...(await input.loadGroups())
        .filter((group) => groupIds.includes(group.groupId))
        .map((group) => ({
          target: {
            platform: 'qq' as const,
            accountId: String(input.selfNumber),
            kind: 'group' as const,
            externalId: String(group.groupId),
          },
          displayName: group.groupName,
        })),
      ...(await input.loadFriends()).map((friend) => ({
        target: {
          platform: 'qq' as const,
          accountId: String(input.selfNumber),
          kind: 'private' as const,
          externalId: String(friend.userId),
        },
        displayName: friend.remark || friend.nickname,
      })),
      ...(await input.loadAdditionalConversations?.() ?? []),
    ],
  })
  const getCurrentTarget = () => conversations.getCurrent()
  const sendMessageSafetyGuard = createSendMessageSafetyGuard({
    getCurrentTarget,
    hasPendingPrivateMailbox: (target) => {
      const messages = input.context.getSnapshot().messages
      if (findPendingMailboxThroughRowId(messages, conversationKey(target)) != null) return true
      return target.platform === 'qq' && target.kind === 'private'
        ? findPendingMailboxThroughRowId(messages, `qq_private:${target.externalId}`) != null
        : false
    },
  })
  const baseTools = createDeferredToolExecutor({
    ...buildBotToolManifest({
      llm: input.llm,
      sender: input.sender,
      delivery,
      groupMuteInspector: input.groupMuteInspector,
      targetPolicy,
      conversations,
      taskRegistry,
      taskScheduler: input.taskScheduler,
      scheduleRuntime,
      approvalManager,
      mcpManager,
      goalStore: input.goalStore,
      goalCompletionJudge,
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
      ownerIdentities: input.ownerIdentities,
      additionalConversations: input.loadAdditionalConversations,
      selfExternalIds: input.selfExternalIds,
    }),
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
        createSendMessageWorkCommitmentHook({
          getCurrentGoal: async () => await input.goalStore?.get() ?? null,
        }),
        sendMessageSafetyGuard.beforeTool,
      ],
      afterTool: [sendMessageSafetyGuard.afterTool, createGenerateImageTaskLogHook()],
    },
  })
  const tools = input.activityReporter
    ? createActivityTrackingToolExecutor(baseTools, input.activityReporter)
    : baseTools

  const systemPrompt = buildBotSystemPrompt({
    groupIds,
    groupPolicies: input.groupPolicies,
    metadata: input.metadata,
    selfNumber: input.selfNumber,
    owner: input.owner,
  })
  const stateAdvisor = createAgentStateAdvisor({
    llm: input.llm,
    systemPrompt,
    getMessages: () => input.context.getSnapshot().messages,
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
    getConversationFocus: () => conversationFocus,
    syncConversationFocus: (focus) => {
      conversationFocus = focus
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
    activityReporter: input.activityReporter,
    onEventsCommitted: input.onEventsCommitted,
    stateAdvisor,
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
