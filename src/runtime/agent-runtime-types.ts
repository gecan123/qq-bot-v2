import type { Prisma } from '../generated/prisma/client.js'

export const MAIN_AGENT_ID = 'agent:main'
export const AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1

export type AgentId = typeof MAIN_AGENT_ID
export type SceneKind = 'qq_group' | 'qq_private' | 'news_feed' | 'forum' | 'workspace' | 'maintenance'
export type SceneId = `${SceneKind}:${string}`
export type RuntimeEventType = 'group_message' | 'scheduler_tick' | 'manual_wake'
export type QueueKind = 'obligation' | 'social' | 'maintenance'
export type OpportunityType = 'reply_to_mention' | 'ambient_candidate' | 'maintenance'
export type ActionType = 'reply_to_message' | 'send_group_message' | 'artifact_only'
export type ActionIntentStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'suppressed'
export type ActionDeliveryState = 'pending' | 'sending' | 'acked' | 'sent' | 'failed' | 'dry_run' | 'suppressed'

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
  opportunityId: string
  shouldAct: boolean
  actionType: ActionType
  dryRun: boolean
  reason: string
}

export interface ActionIntent {
  id: string
  opportunityId: string
  actionType: ActionType
  targetSceneId: SceneId
  payload: Prisma.JsonObject
  dryRun: boolean
  riskLevel: 'low' | 'medium' | 'high'
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
