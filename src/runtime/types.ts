export const MAIN_AGENT_ID = 'agent:main' as const
export const ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 2
export const DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT = 200
export const DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT = 50

export type AgentId = string
export type SceneKind = 'qq_group' | 'qq_private' | 'news_feed' | 'forum' | 'workspace' | 'maintenance'
export type SceneId = string & { readonly __brand: 'SceneId' }
export type FocusTargetId = 'portal' | SceneId
export type RuntimeCueDeliveryMode = 'reply_to_message' | 'send_message'

export interface RuntimeSceneRecord {
  sceneId: SceneId
  kind: Extract<SceneKind, 'qq_group' | 'qq_private'>
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
  cueStrength: 'strong' | 'weak'
  replyModeHint: 'anchored' | 'unanchored'
  preferredDeliveryMode: RuntimeCueDeliveryMode
  mustReplyOverride: boolean
  status: 'pending' | 'suppressed' | 'refused' | 'replied' | 'delivery_failed'
  createdAt: string
}

export interface RuntimeUnreadMessage {
  groupId?: number
  messageRowId: number
  messageId: number
  senderId: number
  senderNickname: string
  text?: string
  mentionedSelf?: boolean
  createdAt: string
}

export interface RuntimeSenderContinuity {
  groupId?: number
  senderId: number
  senderThreadKey?: string
  lastMessageRowId?: number
  lastSeenMessageRowId?: number | null
  lastMaterializedMessageRowId?: number | null
  lastMessageId?: number
  lastSeenAt?: string
  updatedAt: string
}

export interface RuntimeAmbientAuditCandidate {
  opportunityId: string
  groupId: number
  sceneId: SceneId
  triggerMessageRowId: number
  incorporatedMessageRowId: number
  score: number
  reason: string
  createdAt: string
}

export type ProactiveCandidateStatus = 'suppressed' | 'no_candidate' | 'candidate_generated'

export interface ProactiveCandidateArtifact {
  artifactKind: 'proactive_candidate'
  opportunityId: string
  runtimeKey: string
  groupId: number
  sceneId: string
  sourceKind: string
  triggerMessageRowId: number
  incorporatedMessageRowId: number
  createdAt: string
  expiresAt: string
  score: number
  gateReasons: string[]
  termination: string
  status: ProactiveCandidateStatus
  candidateText?: string
  model?: string
  tokenUsage?: unknown
  tokenUsageState?: string
  policyReasons?: string[]
  judgeAdvice?: unknown
  durationMs?: number
}

export interface RuntimeProactiveGenerationAttempt {
  opportunityId?: string
  attemptedAt: string
  messageRowId?: number
  groupId?: number
  sceneId?: string
}

export type RuntimeProactiveJudgeAttempt = RuntimeProactiveGenerationAttempt

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
  ambientAuditCandidates?: RuntimeAmbientAuditCandidate[]
  sceneRecords?: RuntimeSceneRecord[]
  outstandingCues?: RuntimeCue[]
  proactiveCandidateArtifacts?: ProactiveCandidateArtifact[]
  proactiveGenerationAttempts?: RuntimeProactiveGenerationAttempt[]
  proactiveJudgeAttempts?: RuntimeProactiveGenerationAttempt[]
  recentObservedMessageRowIds: number[]
  lastWakeAt?: string | null
}

export interface RootRuntimeSnapshotRecord {
  id: number
  agentId?: AgentId
  /** Deprecated compatibility alias: root is always agent:main. */
  runtimeKey: string
  /** Deprecated compatibility field: qq_group lives in Scene records. */
  groupId: number
  schemaVersion: number
  contextSnapshot: RootRuntimeContextSnapshot
  sessionSnapshot: RootRuntimeSessionSnapshot
  createdAt: Date
  lastObservedMessageRowId?: number
  updatedAt: Date
}

export interface CreateRootRuntimeSnapshotInput {
  agentId?: AgentId
  runtimeKey: string
  groupId: number
  lastObservedMessageRowId?: number
  schemaVersion: number
  contextSnapshot: RootRuntimeContextSnapshot
  sessionSnapshot: RootRuntimeSessionSnapshot
}

export function makeAgentRuntimeKey(): AgentId {
  return MAIN_AGENT_ID
}

export function makeGroupRuntimeKey(_groupId: number): AgentId {
  return MAIN_AGENT_ID
}

export function makeSceneId(groupId: number): SceneId {
  return `qq_group:${groupId}` as SceneId
}

export function makeMentionCueId(sceneId: SceneId, triggerMessageRowId: number): string {
  return `${sceneId}:message:${triggerMessageRowId}`
}

export function makeMentionReplyIntentId(groupId: number, triggerMessageRowId: number): string {
  return makeMentionCueId(makeSceneId(groupId), triggerMessageRowId)
}

export function createDefaultRootRuntimeSnapshot(_groupId?: number): CreateRootRuntimeSnapshotInput {
  return {
    agentId: MAIN_AGENT_ID,
    runtimeKey: MAIN_AGENT_ID,
    groupId: _groupId ?? 0,
    schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    contextSnapshot: { messages: [] },
    sessionSnapshot: {
      focusedStateId: 'portal',
      stateStack: ['portal'],
      focusedTargetId: 'portal',
      unreadMessages: [],
      senderContinuities: [],
      ambientAuditCandidates: [],
      sceneRecords: [],
      outstandingCues: [],
      proactiveCandidateArtifacts: [],
      proactiveGenerationAttempts: [],
      recentObservedMessageRowIds: [],
      lastWakeAt: null,
    },
  }
}
