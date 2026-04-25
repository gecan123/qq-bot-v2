import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'

export type ActionDeliveryState = 'pending' | 'sending' | 'acked' | 'sent' | 'failed' | 'dry_run' | 'suppressed' | 'skipped'

export interface ActionIntentRecord {
  id: string
  opportunityId: string
  actionType: string
  targetSceneId: string
  payload: Record<string, unknown>
  dryRun: boolean
  riskLevel: string
  status: string
  idempotencyKey: string
}

export interface ActionRecord {
  id: string
  actionIntentId: string
  actionType: string
  targetSceneId: string
  deliveryState: ActionDeliveryState
  idempotencyKey: string
  resultPayload?: Record<string, unknown> | null
  createdAt?: Date
  updatedAt?: Date
}

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item) ?? null)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item) ?? null]))
  return String(value)
}

function mapIntent(row: Awaited<ReturnType<typeof prisma.actionIntent.findUnique>> extends infer T ? T extends null ? never : T : never): ActionIntentRecord {
  return { id: row.id, opportunityId: row.opportunityId, actionType: row.actionType, targetSceneId: row.targetSceneId, payload: row.payload as Record<string, unknown>, dryRun: row.dryRun, riskLevel: row.riskLevel, status: row.status, idempotencyKey: row.idempotencyKey }
}

function mapRecord(row: Awaited<ReturnType<typeof prisma.actionRecord.findUnique>> extends infer T ? T extends null ? never : T : never): ActionRecord {
  return {
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType,
    targetSceneId: row.targetSceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload as Record<string, unknown> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function createOrReuseActionIntent(input: {
  id: string
  opportunityId: string
  actionType: string
  targetSceneId: string
  payload: Record<string, unknown>
  dryRun: boolean
  riskLevel?: string
  status?: string
  idempotencyKey: string
}): Promise<ActionIntentRecord> {
  const row = await prisma.actionIntent.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    create: { id: input.id, opportunityId: input.opportunityId, actionType: input.actionType, targetSceneId: input.targetSceneId, payload: sanitizeJsonValue(input.payload) as Prisma.InputJsonObject, dryRun: input.dryRun, riskLevel: input.riskLevel ?? 'low', status: input.status ?? 'pending', idempotencyKey: input.idempotencyKey },
    update: {},
  })
  return mapIntent(row)
}

export async function createOrReuseActionRecord(input: {
  id: string
  actionIntentId: string
  actionType: string
  targetSceneId: string
  deliveryState: ActionDeliveryState
  idempotencyKey: string
  resultPayload?: Record<string, unknown> | null
}): Promise<ActionRecord> {
  const row = await prisma.actionRecord.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: { id: input.id, actionIntentId: input.actionIntentId, actionType: input.actionType, targetSceneId: input.targetSceneId, deliveryState: input.deliveryState, idempotencyKey: input.idempotencyKey, resultPayload: input.resultPayload ? sanitizeJsonValue(input.resultPayload) as Prisma.InputJsonObject : undefined },
    update: {},
  })
  return mapRecord(row)
}

export async function markActionRecordDeliveryState(id: string, deliveryState: ActionDeliveryState, resultPayload?: Record<string, unknown> | null): Promise<ActionRecord> {
  const row = await prisma.actionRecord.update({ where: { id }, data: { deliveryState, resultPayload: resultPayload === undefined ? undefined : resultPayload === null ? undefined : sanitizeJsonValue(resultPayload) as Prisma.InputJsonObject } })
  return mapRecord(row)
}

export async function listRecoverableActionRecords(targetSceneIds?: string[]): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      deliveryState: { in: ['pending', 'sending', 'failed', 'acked'] },
      ...(targetSceneIds && targetSceneIds.length > 0 ? { targetSceneId: { in: targetSceneIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(mapRecord)
}

export async function listSentActionRecordsForScene(targetSceneId: string): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      targetSceneId,
      deliveryState: { in: ['sent', 'acked'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(mapRecord)
}
