import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import {
  AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  MAIN_AGENT_ID,
  makeSceneId,
  type AgentId,
  type ActionDeliveryState,
  type ActionIntentStatus,
  type ActionRecord,
  type ActionType,
  type OpportunityType,
  type QueueKind,
  type ReferencePayload,
  type RuntimeEventRecord,
  type RuntimeEventType,
  type SceneId,
  type SceneKind,
} from './agent-runtime-types.js'

const ALLOWED_REFERENCE_KEYS = new Set(['messageRowId', 'messageId', 'ingestSource', 'source', 'idempotencyKey'])
const FORBIDDEN_REFERENCE_KEYS = new Set([
  'segments',
  'plainText',
  'content',
  'rawContent',
  'rawMessage',
  'senderNickname',
  'senderGroupNickname',
  'mediaDescriptions',
  'resolvedText',
])

function makeId(prefix: string, key: string): string {
  return `${prefix}:${Buffer.from(key).toString('base64url').slice(0, 96)}`
}

function asJsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {}
}

function toReferencePayload(payload: ReferencePayload): Prisma.JsonObject {
  const out: Prisma.JsonObject = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key) || FORBIDDEN_REFERENCE_KEYS.has(key)) {
      throw new Error(`runtime reference payload contains unsupported key: ${key}`)
    }
    out[key] = value
  }
  return out
}

export function assertReferenceOnlyPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key) || FORBIDDEN_REFERENCE_KEYS.has(key)) {
      throw new Error(`runtime payload must be reference-only; forbidden key: ${key}`)
    }
  }
}

export function buildMessageReferencePayload(input: {
  messageRowId: number
  messageId: number
  ingestSource?: string
  source?: string
  idempotencyKey: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messageRowId: input.messageRowId,
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
  }
  if (input.ingestSource) payload.ingestSource = input.ingestSource
  if (input.source) payload.source = input.source
  assertReferenceOnlyPayload(payload)
  return payload
}

export async function getOrCreateMainAgentRuntime() {
  return prisma.agentRuntimeSnapshot.upsert({
    where: { agentId: MAIN_AGENT_ID },
    update: {},
    create: {
      agentId: MAIN_AGENT_ID,
      schemaVersion: AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: { messages: [] },
      sessionSnapshot: { scenes: [] },
    },
  })
}

export async function getAgentRuntimeSnapshot(agentId: AgentId = MAIN_AGENT_ID) {
  return prisma.agentRuntimeSnapshot.findUnique({ where: { agentId } })
}

export async function upsertAgentRuntimeSnapshot(input: {
  agentId?: AgentId
  schemaVersion?: number
  contextSnapshot: Prisma.JsonObject
  sessionSnapshot: Prisma.JsonObject
}) {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  return prisma.agentRuntimeSnapshot.upsert({
    where: { agentId },
    update: {
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot: input.sessionSnapshot,
    },
    create: {
      agentId,
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot: input.sessionSnapshot,
    },
  })
}

export async function getOrCreateScene(input: {
  agentId?: AgentId
  kind: SceneKind
  externalId: string | number
  displayName?: string | null
  policy?: Prisma.JsonObject
}) {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const externalId = String(input.externalId)
  return prisma.scene.upsert({
    where: { agentId_kind_externalId: { agentId, kind: input.kind, externalId } },
    update: {
      displayName: input.displayName ?? undefined,
      policy: input.policy ?? undefined,
    },
    create: {
      id: makeSceneId(input.kind, externalId),
      agentId,
      kind: input.kind,
      externalId,
      displayName: input.displayName ?? null,
      policy: input.policy ?? {},
    },
  })
}

export async function createOrReuseRuntimeEvent(input: {
  sceneId: SceneId
  eventType: RuntimeEventType
  payload: ReferencePayload
  occurredAt: Date
  idempotencyKey: string
}): Promise<RuntimeEventRecord> {
  const row = await prisma.runtimeEvent.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('event', `${input.sceneId}:${input.idempotencyKey}`),
      sceneId: input.sceneId,
      eventType: input.eventType,
      payload: toReferencePayload(input.payload),
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    },
  })
  return {
    id: row.id,
    sceneId: row.sceneId as SceneId,
    eventType: row.eventType as RuntimeEventType,
    payload: asJsonObject(row.payload) as ReferencePayload,
    occurredAt: row.occurredAt,
    idempotencyKey: row.idempotencyKey,
    consumedAt: row.consumedAt,
  }
}

export async function createOrReuseOpportunity(input: {
  sceneId: SceneId
  runtimeEventId?: string | null
  queueKind: QueueKind
  opportunityType: OpportunityType
  priority?: number
  deadlineAt?: Date | null
  payload: ReferencePayload
  status?: string
  idempotencyKey: string
}) {
  return prisma.opportunity.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('opportunity', `${input.sceneId}:${input.idempotencyKey}`),
      sceneId: input.sceneId,
      runtimeEventId: input.runtimeEventId ?? null,
      queueKind: input.queueKind,
      opportunityType: input.opportunityType,
      priority: input.priority ?? 0,
      deadlineAt: input.deadlineAt ?? null,
      payload: toReferencePayload(input.payload),
      status: input.status ?? 'pending',
      idempotencyKey: input.idempotencyKey,
    },
  })
}

export async function createOrReuseActionIntent(input: {
  opportunityId: string
  actionType: ActionType
  targetSceneId: SceneId
  payload: Prisma.JsonObject
  dryRun?: boolean
  riskLevel?: string
  status?: ActionIntentStatus
  idempotencyKey: string
}) {
  return prisma.actionIntent.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('intent', `${input.opportunityId}:${input.idempotencyKey}`),
      opportunityId: input.opportunityId,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      payload: input.payload,
      dryRun: input.dryRun ?? false,
      riskLevel: input.riskLevel ?? 'low',
      status: input.status ?? 'pending',
      idempotencyKey: input.idempotencyKey,
    },
  })
}

export async function createOrReuseActionRecord(input: {
  actionIntentId: string
  actionType: ActionType
  targetSceneId: SceneId
  deliveryState?: ActionDeliveryState
  idempotencyKey: string
  resultPayload?: Prisma.JsonObject | null
}): Promise<ActionRecord> {
  const row = await prisma.actionRecord.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      id: makeId('action', input.idempotencyKey),
      actionIntentId: input.actionIntentId,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      deliveryState: input.deliveryState ?? 'pending',
      idempotencyKey: input.idempotencyKey,
      resultPayload: input.resultPayload ?? Prisma.JsonNull,
    },
  })
  return {
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function markActionRecordDeliveryState(
  id: string,
  deliveryState: ActionDeliveryState,
  resultPayload?: Prisma.JsonObject | null,
): Promise<void> {
  await prisma.actionRecord.update({
    where: { id },
    data: {
      deliveryState,
      resultPayload: resultPayload === undefined ? undefined : resultPayload ?? Prisma.JsonNull,
    },
  })
}

export async function listSentActionRecordsForScene(sceneId: SceneId): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      targetSceneId: sceneId,
      deliveryState: { in: ['sent', 'acked'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function listRecoverableActionRecords(sceneIds?: SceneId[]): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      ...(sceneIds?.length ? { targetSceneId: { in: sceneIds } } : {}),
      deliveryState: { in: ['pending', 'sending', 'failed', 'acked'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}
