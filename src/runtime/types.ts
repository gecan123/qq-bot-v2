import type { ProactiveJudgeAdvice } from './proactive-judge.js'
import type { TokenUsageSummary } from '../llm/token-usage.js'

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

export interface RuntimeAmbientAuditCandidate {
  id: string
  createdAt: string
  text: string
  triggerMessageRowId?: number
  status: 'dry_run'
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
  policyReasons?: string[]
  judgeAdvice?: ProactiveJudgeAdvice
  candidateText?: string
  termination: string
  model?: string
  tokenUsage?: TokenUsageSummary
  tokenUsageState?: 'captured' | 'not_applicable' | 'unknown'
  durationMs?: number
  status: ProactiveCandidateStatus
}

export interface RuntimeProactiveGenerationAttempt {
  opportunityId: string
  attemptedAt: string
}

export interface RuntimeProactiveJudgeAttempt {
  messageRowId: number
  attemptedAt: string
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
  ambientAuditCandidates: RuntimeAmbientAuditCandidate[]
  proactiveCandidateArtifacts?: ProactiveCandidateArtifact[]
  proactiveGenerationAttempts?: RuntimeProactiveGenerationAttempt[]
  proactiveJudgeAttempts?: RuntimeProactiveJudgeAttempt[]
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

export function makeMainAgentRuntimeKey(): string {
  return 'agent:main'
}

export function makeSceneId(groupId: number): SceneId {
  return `qq_group:${groupId}` as SceneId
}

export function makeMentionCueId(sceneId: SceneId, triggerMessageRowId: number): string {
  return `${sceneId}:message:${triggerMessageRowId}:reply_to_message`
}

export function makeMentionReplyIntentId(groupId: number, triggerMessageRowId: number): string {
  return makeMentionCueId(makeSceneId(groupId), triggerMessageRowId)
}

export function createDefaultRootRuntimeSnapshot(groupId: number): CreateRootRuntimeSnapshotInput {
  const runtimeKey = makeMainAgentRuntimeKey()
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
      ambientAuditCandidates: [],
      proactiveCandidateArtifacts: [],
      proactiveGenerationAttempts: [],
      proactiveJudgeAttempts: [],
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
