import { prisma } from '../database/client.js'

export interface CreateReplyAuditInput {
  replyRecordId?: number
  runtimeKey: string
  groupId: number
  scopeKey: string
  replyIntentId: string
  opportunityId?: string
  auditKind: string
  payload: unknown
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item))
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)]),
    )
  }

  return String(value)
}

function resolveOpportunityId(input: CreateReplyAuditInput): string {
  return input.opportunityId ?? input.replyIntentId
}

export async function createReplyAudit(input: CreateReplyAuditInput): Promise<void> {
  const opportunityId = resolveOpportunityId(input)
  await prisma.replyAudit.create({
    data: {
      replyRecordId: input.replyRecordId ?? null,
      runtimeKey: input.runtimeKey,
      groupId: BigInt(input.groupId),
      scopeKey: input.scopeKey,
      replyIntentId: input.replyIntentId,
      opportunityId,
      auditKind: input.auditKind,
      payload: sanitizeJsonValue(input.payload) as object,
    },
  })
}

export async function createOrReuseReplyAudit(input: CreateReplyAuditInput): Promise<void> {
  const opportunityId = resolveOpportunityId(input)

  await prisma.replyAudit.upsert({
    where: {
      runtimeKey_opportunityId_auditKind: {
        runtimeKey: input.runtimeKey,
        opportunityId,
        auditKind: input.auditKind,
      },
    },
    create: {
      replyRecordId: input.replyRecordId ?? null,
      runtimeKey: input.runtimeKey,
      groupId: BigInt(input.groupId),
      scopeKey: input.scopeKey,
      replyIntentId: input.replyIntentId,
      opportunityId,
      auditKind: input.auditKind,
      payload: sanitizeJsonValue(input.payload) as object,
    },
    update: {
      replyRecordId: input.replyRecordId ?? null,
      groupId: BigInt(input.groupId),
      scopeKey: input.scopeKey,
      replyIntentId: input.replyIntentId,
      payload: sanitizeJsonValue(input.payload) as object,
    },
  })
}
