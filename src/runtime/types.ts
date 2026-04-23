export const ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 2
export const DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT = 50
export const DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT = 32

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

export interface RuntimeProactiveCandidate {
  id: string
  createdAt: string
  text: string
  triggerMessageRowId?: number
  status: 'dry_run'
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
  proactiveCandidates: RuntimeProactiveCandidate[]
  sceneRecords?: RuntimeSceneRecord[]
  outstandingCues?: RuntimeCue[]
  recentObservedMessageRowIds: number[]
  lastWakeAt: string | null
}

export interface RootRuntimeSnapshotRecord {
  id: number
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
  runtimeKey: string
  groupId: number
  schemaVersion: number
  contextSnapshot: RootRuntimeContextSnapshot
  sessionSnapshot: RootRuntimeSessionSnapshot
  lastObservedMessageRowId?: number
}

export function makeGroupRuntimeKey(groupId: number): string {
  return `qq_group:${groupId}`
}

export function makeSceneId(groupId: number): SceneId {
  return makeGroupRuntimeKey(groupId) as SceneId
}

export function makeMentionCueId(sceneId: SceneId, triggerMessageRowId: number): string {
  return `${sceneId}:message:${triggerMessageRowId}:reply_to_message`
}

export function makeMentionReplyIntentId(groupId: number, triggerMessageRowId: number): string {
  return makeMentionCueId(makeSceneId(groupId), triggerMessageRowId)
}

export function createDefaultRootRuntimeSnapshot(groupId: number): CreateRootRuntimeSnapshotInput {
  const runtimeKey = makeGroupRuntimeKey(groupId)
  const sceneId = makeSceneId(groupId)
  return {
    runtimeKey,
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
      proactiveCandidates: [],
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
