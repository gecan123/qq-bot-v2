import { createBotLoopAgent, type BotLoopAgent, type BotLoopLifeJournal } from './bot-loop-agent.js'
import { buildBotSystemPrompt } from './bot-system-prompt.js'
import { createInMemoryTaskRegistry } from './background-task-registry.js'
import { renderBotEvent } from './render-event.js'
import { createSendTargetPolicy } from './send-target-policy.js'
import { createDeferredToolExecutor, type ToolExecutor } from './tool.js'
import { createGenerateImageTaskLogHook, createSendMessageAiToneHook } from './tool-policy-hooks.js'
import { buildBotToolManifest } from './tools/index.js'
import type { AgentContext } from './agent-context.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import type { MailboxCursors } from './mailbox.js'
import type { TargetMetadataMaps } from './resolve-target-meta.js'
import type { GroupCustomization } from '../config/group-prompts.js'
import type { BotOwner } from '../config/index.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { isGroupMessageMentioningUser } from '../database/messages.js'

export interface AgentRuntimeInput {
  context: AgentContext
  eventQueue: EventQueue<BotEvent>
  llm: LlmClient
  snapshotRepo: BotSnapshotRepo
  sender: MessageSender
  loadFriendIds: () => Promise<readonly number[]>
  groupIds: readonly number[]
  groupAmbientSendIds: ReadonlySet<number>
  selfNumber: number
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
  toolCallLogPath: string
  owner: BotOwner | null
  eventDebounceMs?: number
  initialMailboxCursors?: Readonly<MailboxCursors>
  initialLastWakeAt?: Date | null
  lifeJournal?: BotLoopLifeJournal
}

export interface AgentRuntime {
  tools: ToolExecutor
  systemPrompt: string
  agent: BotLoopAgent
}

export function createAgentRuntime(input: AgentRuntimeInput): AgentRuntime {
  const taskRegistry = createInMemoryTaskRegistry()
  const targetPolicy = createSendTargetPolicy({
    groupIds: input.groupIds,
    groupAmbientSendIds: input.groupAmbientSendIds,
    loadFriendIds: input.loadFriendIds,
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
      groupIds: input.groupIds,
      selfNumber: input.selfNumber,
      metadata: input.metadata,
      groupCustomizations: input.groupCustomizations,
    }),
    activeCapabilities: {
      list: () => input.context.getSnapshot().activeToolCapabilities,
      activate: (capability) => input.context.activateToolCapability(capability),
      deactivate: (capability) => input.context.deactivateToolCapability(capability),
    },
    trace: { path: input.toolCallLogPath, persistToDb: true },
    hooks: {
      beforeTool: [createSendMessageAiToneHook()],
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
    initialLastWakeAt: input.initialLastWakeAt ?? null,
    renderEvent: renderBotEvent,
    eventDebounceMs: input.eventDebounceMs,
    lifeJournal: input.lifeJournal,
  })

  return { tools, systemPrompt, agent }
}
