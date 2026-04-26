import type { Prisma } from '../generated/prisma/client.js'

export const MAIN_AGENT_ID = 'agent:main'
export const AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1

export type AgentId = typeof MAIN_AGENT_ID
export type SceneKind = 'qq_group' | 'qq_private' | 'news_feed' | 'forum' | 'workspace' | 'maintenance'
export type SceneId = `${SceneKind}:${string}`
export type RuntimeEventType =
  | 'qq_group_message_received'
  | 'qq_private_message_received'
  | 'forum_item_seen'
  | 'news_item_seen'
  | 'task_due'
  | 'memory_maintenance_due'
  | 'self_spine_review_due'
  | 'scheduler_tick'
  | 'manual_wake'
export type QueueKind = 'obligation' | 'social' | 'curiosity' | 'maintenance'
export type OpportunityType =
  | 'reply_to_mention'
  | 'observe_group'
  | 'proactive_candidate'
  | 'reply_private_message'
  | 'read_forum_post'
  | 'read_news_item'
  | 'run_task'
  | 'review_memory_proposal'
  | 'review_self_spine_update'
  | 'maintenance'
export type ActionType =
  | 'reply_to_message'
  | 'send_group_reply'
  | 'send_group_message'
  | 'send_private_message'
  | 'read_forum_post'
  | 'read_news_item'
  | 'create_memory_proposal'
  | 'update_self_spine'
  | 'artifact_only'
export type ActionIntentStatus = 'proposed' | 'rejected' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'skipped'
export type ActionDeliveryState = 'pending' | 'sending' | 'acked' | 'sent' | 'failed' | 'dry_run' | 'suppressed' | 'skipped'
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type DecisionVerdict = 'approved' | 'rejected' | 'dry_run' | 'skipped'

export interface Agent {
  id: AgentId
}

export interface SceneIdentity {
  id: SceneId
  agentId: AgentId
  kind: SceneKind
  externalId: string
}

export interface Actor {
  kind: 'qq_user' | 'system'
  externalId: string
  sceneId?: SceneId
}

export interface ReferencePayload extends Record<string, Prisma.JsonValue | undefined> {
  messageRowId?: number
  messageId?: number
  feedSourceId?: string
  feedItemId?: string
  contentHash?: string
  readSessionId?: string
  actionRecordId?: string
  ingestSource?: string
  source?: string
  idempotencyKey?: string
}

export interface RuntimeEventRecord {
  id: string
  sceneId: SceneId
  eventType: RuntimeEventType
  payload: ReferencePayload
  occurredAt: Date
  idempotencyKey: string
  consumedAt: Date | null
}

export interface Opportunity {
  id: string
  sceneId: SceneId
  runtimeEventId: string | null
  queueKind: QueueKind
  opportunityType: OpportunityType
  priority: number
  deadlineAt: Date | null
  payload: ReferencePayload
  status: string
  idempotencyKey: string
}

export interface Decision {
  id: string
  opportunityId: string
  idempotencyKey: string
  policyVersion: string
  verdict: DecisionVerdict
  actionType: ActionType
  riskLevel: RiskLevel
  reason: string
  barrierInput: Prisma.JsonObject
  barrierOutput: Prisma.JsonObject
  createdAt: Date
}

export interface ActionIntent {
  id: string
  opportunityId: string
  decisionId: string | null
  actionType: ActionType
  targetSceneId: SceneId
  payload: Prisma.JsonObject
  dryRun: boolean
  riskLevel: RiskLevel
  status: ActionIntentStatus
  idempotencyKey: string
}

export interface ActionRecord {
  id: string
  actionIntentId: string
  actionType: ActionType
  targetSceneId: SceneId
  deliveryState: ActionDeliveryState
  idempotencyKey: string
  resultPayload: Prisma.JsonObject | null
  createdAt: Date
  updatedAt: Date
}

export interface DormantMemoryContract {
  id: string
  agentId: AgentId
  scope: string
  payload: Prisma.JsonObject
  status?: 'dormant'
}

export interface MemoryProposal {
  id: string
  agentId: AgentId
  sourceRef: Prisma.JsonObject
  proposalType: string
  payload: Prisma.JsonObject
  confidence?: number | null
  salience?: number | null
  status: 'proposed' | 'accepted' | 'rejected' | 'edited' | 'expired'
  idempotencyKey: string
  createdAt: Date
  updatedAt: Date
}

export function getMainAgentId(): AgentId {
  return MAIN_AGENT_ID
}

export function makeMainAgentRuntimeKey(): AgentId {
  return MAIN_AGENT_ID
}

export function makeSceneId(kind: SceneKind, externalId: string | number): SceneId {
  return `${kind}:${String(externalId)}` as SceneId
}

export function makeQqGroupSceneId(external: number | string): SceneId {
  return makeSceneId('qq_group', external)
}

export function makeQqPrivateSceneId(external: number | string): SceneId {
  return makeSceneId('qq_private', external)
}
