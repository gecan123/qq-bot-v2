import { createBotLoopAgent, type BotLoopAgent, type BotLoopLifeJournal } from './bot-loop-agent.js'
import { buildBotSystemPrompt } from './bot-system-prompt.js'
import {
  createInMemoryTaskRegistry,
  type BackgroundTaskRegistry,
} from './background-task-registry.js'
import { renderBotEvent } from './render-event.js'
import { createSendTargetPolicy } from './send-target-policy.js'
import { createDeferredToolExecutor, type ToolExecutor } from './tool.js'
import { createGenerateImageTaskLogHook, createSendMessageAiToneHook } from './tool-policy-hooks.js'
import { createOwnerApprovalHook, type ApprovalMode } from './approval-policy.js'
import { buildBotToolManifest, type BotOptionalTools } from './tools/index.js'
import type { AgentContext } from './agent-context.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import type { MailboxCursors } from './mailbox.js'
import type { MailboxContinuityState } from './mailbox-continuity.js'
import type { TargetMetadataMaps } from './resolve-target-meta.js'
import type { GroupCustomization } from '../config/group-prompts.js'
import type { BotOwner } from '../config/index.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { isGroupMessageMentioningUser } from '../database/messages.js'
import { findApprovalEvidenceMessage } from '../database/messages.js'
import type { TaskScheduler } from './task-scheduler.js'
import type { QqDirectoryFriend, QqDirectoryGroup } from './tools/qq-directory.js'
import {
  createDurableWakeScheduler,
  type DurableWakeScheduler,
} from './durable-wake-scheduler.js'
import { createApprovalManager, type ApprovalManager } from './approval-manager.js'
import {
  createMcpManagerFromConfigFile,
  type McpManager,
} from './mcp-manager.js'
import type { GoalStore } from './goal-store.js'
import type { MemoryMaintenanceRuntime } from './memory-maintenance.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

export interface AgentRuntimeInput {
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  snapshotRepo: BotSnapshotRepo
  sender: MessageSender
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
  groupIds: readonly number[]
  groupAmbientSendIds: ReadonlySet<number>
  selfNumber: number
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
  toolCallLogPath: string
  toolAuditMode?: 'all' | 'side_effects' | 'off'
  toolAuditDbEnabled?: boolean
  owner: BotOwner | null
  eventDebounceMs?: number
  initialMailboxCursors?: Readonly<MailboxCursors>
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
  wakeScheduler?: DurableWakeScheduler
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
  stopBackgroundServices(): Promise<void>
}

export function createAgentRuntime(input: AgentRuntimeInput): AgentRuntime {
  const taskRegistry = input.taskRegistry ?? createInMemoryTaskRegistry()
  const wakeScheduler = input.wakeScheduler ?? createDurableWakeScheduler({
    registry: taskRegistry,
    eventQueue: input.eventQueue,
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
    groupIds: input.groupIds,
    groupAmbientSendIds: input.groupAmbientSendIds,
    loadFriendIds: async () => (await input.loadFriends()).map((friend) => friend.userId),
    isGroupReplyToSelf: ({ groupId, messageId }) => isGroupMessageMentioningUser(
      groupId,
      messageId,
      input.selfNumber,
    ),
  })
  const tools = createDeferredToolExecutor({
    ...buildBotToolManifest({
      sender: input.sender,
      targetPolicy,
      taskRegistry,
      taskScheduler: input.taskScheduler,
      wakeScheduler,
      llm: input.llm,
      approvalManager,
      mcpManager,
      goalStore: input.goalStore,
      memoryMaintenance: input.memoryMaintenance,
      workspaceDir: input.workspaceDir,
      workspaceStateCoordinator: input.workspaceStateCoordinator,
      optionalTools: input.optionalTools,
      groupIds: input.groupIds,
      selfNumber: input.selfNumber,
      metadata: input.metadata,
      groupCustomizations: input.groupCustomizations,
      qqDirectory: {
        groupIds: input.groupIds,
        loadFriends: input.loadFriends,
        loadGroups: input.loadGroups,
      },
    }),
    activeCapabilities: {
      list: () => input.context.getSnapshot().activeToolCapabilities,
      activate: (capability) => input.context.activateToolCapability(capability),
      deactivate: (capability) => input.context.deactivateToolCapability(capability),
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
        createSendMessageAiToneHook(),
      ],
      afterTool: [createGenerateImageTaskLogHook()],
    },
  })

  const systemPrompt = buildBotSystemPrompt({
    groupIds: input.groupIds,
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
    snapshotRepo: input.snapshotRepo,
    initialMailboxCursors: input.initialMailboxCursors ?? {},
    initialMailboxContinuity: input.initialMailboxContinuity,
    initialLastWakeAt: input.initialLastWakeAt ?? null,
    initialGoalRevision: input.initialGoalRevision ?? 0,
    goalStore: input.goalStore,
    renderEvent: renderBotEvent,
    eventDebounceMs: input.eventDebounceMs,
    lifeJournal: input.lifeJournal,
  })

  return {
    tools,
    systemPrompt,
    agent,
    async stopBackgroundServices() {
      wakeScheduler.stop()
      await mcpManager?.closeAll()
    },
  }
}
