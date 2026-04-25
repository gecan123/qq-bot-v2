import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import { MAIN_AGENT_ID, makeSceneId, type AgentId, type SceneKind } from './types.js'

export const MESSAGE_REFERENCE_PAYLOAD_KEYS = new Set(['messageRowId', 'messageId', 'ingestSource', 'source', 'idempotencyKey'])
const FORBIDDEN_USER_FACT_PAYLOAD_KEYS = new Set([
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

export interface SceneRecord {
  id: string
  agentId: AgentId
  kind: SceneKind
  externalId: string
  displayName?: string | null
  policy?: unknown
}

export interface RuntimeEventRecord {
  id: string
  sceneId: string
  eventType: string
  payload: Record<string, unknown>
  idempotencyKey: string
}

export interface OpportunityRecord {
  id: string
  sceneId: string
  runtimeEventId?: string | null
  queueKind: string
  opportunityType: string
  payload: Record<string, unknown>
  idempotencyKey: string
}

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item) ?? null)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item) ?? null]))
  }
  return String(value)
}

export function assertReferenceOnlyPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!MESSAGE_REFERENCE_PAYLOAD_KEYS.has(key) || FORBIDDEN_USER_FACT_PAYLOAD_KEYS.has(key)) {
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

export async function ensureQqGroupScene(input: {
  groupId: number
  agentId?: AgentId
  displayName?: string | null
  policy?: unknown
}): Promise<SceneRecord> {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const externalId = String(input.groupId)
  const id = makeSceneId(input.groupId)
  const row = await prisma.scene.upsert({
    where: { agentId_kind_externalId: { agentId, kind: 'qq_group', externalId } },
    create: {
      id,
      agentId,
      kind: 'qq_group',
      externalId,
      displayName: input.displayName ?? null,
      policy: input.policy === undefined ? undefined : (sanitizeJsonValue(input.policy) as Prisma.InputJsonValue),
    },
    update: {
      displayName: input.displayName ?? undefined,
      policy: input.policy === undefined ? undefined : (sanitizeJsonValue(input.policy) as Prisma.InputJsonValue),
    },
  })
  return { id: row.id, agentId: row.agentId, kind: row.kind as SceneKind, externalId: row.externalId, displayName: row.displayName, policy: row.policy }
}

export async function createOrReuseRuntimeEvent(input: {
  sceneId: string
  eventType: string
  payload: Record<string, unknown>
  occurredAt: Date
  idempotencyKey: string
}): Promise<RuntimeEventRecord> {
  assertReferenceOnlyPayload(input.payload)
  const row = await prisma.runtimeEvent.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    create: {
      id: `${input.sceneId}:event:${input.idempotencyKey}`,
      sceneId: input.sceneId,
      eventType: input.eventType,
      payload: sanitizeJsonValue(input.payload) as Prisma.InputJsonObject,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    },
    update: {},
  })
  return { id: row.id, sceneId: row.sceneId, eventType: row.eventType, payload: row.payload as Record<string, unknown>, idempotencyKey: row.idempotencyKey }
}

export async function createOrReuseOpportunity(input: {
  id: string
  sceneId: string
  runtimeEventId?: string | null
  queueKind: string
  opportunityType: string
  priority?: number
  deadlineAt?: Date | null
  payload: Record<string, unknown>
  status?: string
  idempotencyKey: string
}): Promise<OpportunityRecord> {
  assertReferenceOnlyPayload(input.payload)
  const row = await prisma.opportunity.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    create: {
      id: input.id,
      sceneId: input.sceneId,
      runtimeEventId: input.runtimeEventId ?? null,
      queueKind: input.queueKind,
      opportunityType: input.opportunityType,
      priority: input.priority ?? 0,
      deadlineAt: input.deadlineAt ?? null,
      payload: sanitizeJsonValue(input.payload) as Prisma.InputJsonObject,
      status: input.status ?? 'pending',
      idempotencyKey: input.idempotencyKey,
    },
    update: {},
  })
  return { id: row.id, sceneId: row.sceneId, runtimeEventId: row.runtimeEventId, queueKind: row.queueKind, opportunityType: row.opportunityType, payload: row.payload as Record<string, unknown>, idempotencyKey: row.idempotencyKey }
}
