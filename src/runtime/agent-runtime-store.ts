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
  type Decision,
  type DecisionVerdict,
  type MemoryProposal,
  type OpportunityType,
  type QueueKind,
  type ReferencePayload,
  type RiskLevel,
  type RuntimeEventRecord,
  type RuntimeEventType,
  type SceneId,
  type SceneKind,
} from './agent-runtime-types.js'

const ALLOWED_REFERENCE_KEYS = new Set([
  'messageRowId',
  'messageId',
  'feedSourceId',
  'feedItemId',
  'contentHash',
  'readSessionId',
  'actionRecordId',
  'ingestSource',
  'source',
  'idempotencyKey',
])
const FORBIDDEN_REFERENCE_KEYS = new Set([
  'segments',
  'plainText',
  'content',
  'text',
  'rawContent',
  'rawMessage',
  'senderNickname',
  'senderGroupNickname',
  'mediaDescriptions',
  'resolvedText',
])
const FORBIDDEN_INBOUND_COPY_KEYS = new Set([
  ...FORBIDDEN_REFERENCE_KEYS,
  'senderId',
])

function makeId(prefix: string, key: string): string {
  return `${prefix}:${Buffer.from(key).toString('base64url').slice(0, 96)}`
}

function asJsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {}
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function mergeStringLists(...lists: unknown[]): string[] {
  const merged = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string' && item) merged.add(item)
    }
  }
  return [...merged]
}

export function mergeRuntimeSessionSnapshot(
  existing: Prisma.JsonObject | null | undefined,
  next: Prisma.JsonObject,
): Prisma.JsonObject {
  const existingSnapshot = asRecord(existing)
  const nextSnapshot = asRecord(next)
  const existingCursors = asRecord(existingSnapshot.sceneCursors)
  const nextCursors = asRecord(nextSnapshot.sceneCursors)
  return {
    ...existingSnapshot,
    ...nextSnapshot,
    scenes: mergeStringLists(existingSnapshot.scenes, nextSnapshot.scenes),
    sceneCursors: {
      ...existingCursors,
      ...nextCursors,
    } as Prisma.JsonObject,
  }
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

function assertNoForbiddenInboundCopies(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenInboundCopies(item, `${path}[${index}]`))
    return
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'text' && path.endsWith('proposedEffect')) {
      continue
    }
    if (FORBIDDEN_INBOUND_COPY_KEYS.has(key)) {
      throw new Error(`runtime payload must not copy inbound user facts; forbidden key: ${path}.${key}`)
    }
    assertNoForbiddenInboundCopies(nested, `${path}.${key}`)
  }
}

export function assertRuntimeSnapshotReferenceOnly(contextSnapshot: Prisma.JsonObject): void {
  assertNoForbiddenInboundCopies(contextSnapshot, 'contextSnapshot')
}

export function assertActionIntentPayloadSafe(payload: Prisma.JsonObject): void {
  assertNoForbiddenInboundCopies(payload, 'actionIntent.payload')
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

export function buildFeedItemReferencePayload(input: {
  feedSourceId: string
  feedItemId: string
  contentHash?: string | null
  idempotencyKey: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    feedSourceId: input.feedSourceId,
    feedItemId: input.feedItemId,
    source: 'feed_items',
    idempotencyKey: input.idempotencyKey,
  }
  if (input.contentHash) payload.contentHash = input.contentHash
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
  assertRuntimeSnapshotReferenceOnly(input.contextSnapshot)
  const existing = await prisma.agentRuntimeSnapshot.findUnique({ where: { agentId } })
  const sessionSnapshot = mergeRuntimeSessionSnapshot(
    existing ? asJsonObject(existing.sessionSnapshot) : null,
    input.sessionSnapshot,
  )
  return prisma.agentRuntimeSnapshot.upsert({
    where: { agentId },
    update: {
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot,
    },
    create: {
      agentId,
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot,
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

export async function createOrReuseDecision(input: {
  opportunityId: string
  idempotencyKey: string
  policyVersion: string
  verdict: DecisionVerdict
  actionType: ActionType
  riskLevel: RiskLevel
  reason: string
  barrierInput: Prisma.JsonObject
  barrierOutput: Prisma.JsonObject
}): Promise<Decision> {
  assertActionIntentPayloadSafe(input.barrierInput)
  assertActionIntentPayloadSafe(input.barrierOutput)
  const row = await prisma.decision.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('decision', `${input.opportunityId}:${input.idempotencyKey}`),
      opportunityId: input.opportunityId,
      idempotencyKey: input.idempotencyKey,
      policyVersion: input.policyVersion,
      verdict: input.verdict,
      riskLevel: input.riskLevel,
      reason: input.reason,
      barrierInput: input.barrierInput,
      barrierOutput: input.barrierOutput,
    },
  })
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    idempotencyKey: row.idempotencyKey,
    policyVersion: row.policyVersion,
    verdict: row.verdict as DecisionVerdict,
    actionType: input.actionType,
    riskLevel: row.riskLevel as RiskLevel,
    reason: row.reason,
    barrierInput: asJsonObject(row.barrierInput),
    barrierOutput: asJsonObject(row.barrierOutput),
    createdAt: row.createdAt,
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
  decisionId?: string | null
  actionType: ActionType
  targetSceneId: SceneId
  payload: Prisma.JsonObject
  dryRun?: boolean
  riskLevel?: RiskLevel
  status?: ActionIntentStatus
  idempotencyKey: string
}) {
  assertActionIntentPayloadSafe(input.payload)
  return prisma.actionIntent.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('intent', `${input.opportunityId}:${input.idempotencyKey}`),
      opportunityId: input.opportunityId,
      decisionId: input.decisionId ?? null,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      payload: input.payload,
      dryRun: input.dryRun ?? false,
      riskLevel: input.riskLevel ?? 'L1',
      status: input.status ?? 'proposed',
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

export async function createOrReuseMemoryProposal(input: {
  agentId?: AgentId
  sourceRef: Prisma.JsonObject
  proposalType: string
  payload: Prisma.JsonObject
  confidence?: number | null
  salience?: number | null
  status?: string
  idempotencyKey: string
}): Promise<MemoryProposal> {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const row = await prisma.memoryProposal.upsert({
    where: { agentId_idempotencyKey: { agentId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('memory-proposal', `${agentId}:${input.idempotencyKey}`),
      agentId,
      sourceRef: input.sourceRef,
      proposalType: input.proposalType,
      payload: input.payload,
      confidence: input.confidence ?? null,
      salience: input.salience ?? null,
      status: input.status ?? 'proposed',
      idempotencyKey: input.idempotencyKey,
    },
  })
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    sourceRef: asJsonObject(row.sourceRef),
    proposalType: row.proposalType,
    payload: asJsonObject(row.payload),
    confidence: row.confidence,
    salience: row.salience,
    status: row.status as MemoryProposal['status'],
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
