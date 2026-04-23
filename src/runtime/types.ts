export const ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 2
export const DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT = 50
export const DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT = 32

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
  unreadMessages: RuntimeUnreadMessage[]
  senderContinuities: RuntimeSenderContinuity[]
  proactiveCandidates: RuntimeProactiveCandidate[]
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

export function createDefaultRootRuntimeSnapshot(groupId: number): CreateRootRuntimeSnapshotInput {
  const runtimeKey = makeGroupRuntimeKey(groupId)
  return {
    runtimeKey,
    groupId,
    schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    contextSnapshot: {
      messages: [],
    },
    sessionSnapshot: {
      focusedStateId: runtimeKey,
      stateStack: [runtimeKey],
      unreadMessages: [],
      senderContinuities: [],
      proactiveCandidates: [],
      recentObservedMessageRowIds: [],
      lastWakeAt: null,
    },
  }
}
