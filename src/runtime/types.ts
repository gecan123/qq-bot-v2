export const ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 2
export const DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT = 50
export const DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT = 32
export const MAIN_AGENT_ID = 'agent:main' as const

export type AgentId = typeof MAIN_AGENT_ID
export type SceneId = `qq_group:${number}` | `qq_private:${number}`
export type FocusTargetId = 'portal' | SceneId
export type RuntimeCueDeliveryMode = 'reply_to_message' | 'send_message'

export interface RuntimeSceneRecord {
  sceneId: SceneId
  kind: 'qq_group' | 'qq_private'
  groupId?: number
  unreadCount: number
  lastObservedMessageRowId: number | null
  lastMaterializedReplyRowId: number | null
  lastFocusedAt: string | null
  lastSpokeAt: string | null
  outstandingCueIds: string[]
}

export interface RuntimeCue {
  cueId: string
  sceneId: SceneId
  cueKind: 'message'
  triggerMessageRowId: number
  messageId: number
  senderId: number
  senderNickname: string
  addressedToAgent: boolean
  cueStrength: 'weak' | 'strong'
  replyModeHint: 'anchored' | 'unanchored'
  preferredDeliveryMode: RuntimeCueDeliveryMode
  mustReplyOverride: boolean
  status: 'pending' | 'suppressed' | 'refused' | 'replied' | 'delivery_failed'
  createdAt: string
}

export interface RuntimeUnreadMessage {
  messageRowId: number
  messageId: number
  senderId: number
  senderNickname: string
  mentionedSelf: boolean
  createdAt: string
}

export interface RuntimeSenderContinuity {
  senderThreadKey: string
  senderId: number
  lastSeenMessageRowId: number
  lastMaterializedMessageRowId: number | null
  updatedAt: string
}

export interface RuntimeContextMessage {
  role: 'user' | 'model'
  kind: 'group_message' | 'assistant_turn'
  orderKey: number
  senderId: number
  content: string
}

export interface RootRuntimeContextSnapshot {
  messages: RuntimeContextMessage[]
}

export interface RootRuntimeSessionSnapshot {
  focusedStateId: string
  stateStack: string[]
  focusedTargetId?: FocusTargetId
  unreadMessages: RuntimeUnreadMessage[]
  senderContinuities: RuntimeSenderContinuity[]
  sceneRecords?: RuntimeSceneRecord[]
  outstandingCues?: RuntimeCue[]
  recentObservedMessageRowIds: number[]
  lastWakeAt: string | null
}

export interface RootRuntimeSnapshotRecord {
  id: number
  agentId?: AgentId
  runtimeKey: string
  groupId: number
  schemaVersion: number
  contextSnapshot: RootRuntimeContextSnapshot
  sessionSnapshot: RootRuntimeSessionSnapshot
  lastObservedMessageRowId?: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateRootRuntimeSnapshotInput {
  agentId?: AgentId
  runtimeKey: string
  groupId: number
  schemaVersion: number
  contextSnapshot: RootRuntimeContextSnapshot
  sessionSnapshot: RootRuntimeSessionSnapshot
  lastObservedMessageRowId?: number
}

export function makeMainAgentRuntimeKey(): string {
  return MAIN_AGENT_ID
}

export function makeAgentRuntimeKey(): AgentId {
  return MAIN_AGENT_ID
}

export function makeSceneId(groupId: number): SceneId {
  return `qq_group:${groupId}` as SceneId
}

export function makePrivateSceneId(userId: number): SceneId {
  return `qq_private:${userId}` as SceneId
}

export function makeMentionCueId(sceneId: SceneId, triggerMessageRowId: number): string {
  return `${sceneId}:message:${triggerMessageRowId}:reply_to_message`
}

export function makeMentionReplyIntentId(groupId: number, triggerMessageRowId: number): string {
  return makeMentionCueId(makeSceneId(groupId), triggerMessageRowId)
}

export function makePrivateReplyIntentId(userId: number, triggerMessageRowId: number): string {
  return `${makePrivateSceneId(userId)}:message:${triggerMessageRowId}:send_private_message`
}

export function createDefaultRootRuntimeSnapshot(groupId = 0): CreateRootRuntimeSnapshotInput {
  const runtimeKey = makeMainAgentRuntimeKey()
  const sceneId = makeSceneId(groupId)
  return {
    runtimeKey,
    agentId: MAIN_AGENT_ID,
    groupId,
    schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    contextSnapshot: {
      messages: [],
    },
    sessionSnapshot: {
      focusedStateId: sceneId,
      stateStack: [sceneId],
      focusedTargetId: sceneId,
      unreadMessages: [],
      senderContinuities: [],
      sceneRecords: [
        {
          sceneId,
          kind: 'qq_group',
          groupId,
          unreadCount: 0,
          lastObservedMessageRowId: null,
          lastMaterializedReplyRowId: null,
          lastFocusedAt: null,
          lastSpokeAt: null,
          outstandingCueIds: [],
        },
      ],
      outstandingCues: [],
      recentObservedMessageRowIds: [],
      lastWakeAt: null,
    },
  }
}
