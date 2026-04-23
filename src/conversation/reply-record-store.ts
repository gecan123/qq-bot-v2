import { prisma } from '../database/client.js'
import { makeGroupRuntimeKey, makeMentionReplyIntentId } from '../runtime/types.js'
import type { AssistantTurnRecord } from './assistant-turn-store.js'
import { parseSenderReplyScopeKey } from './reply-scope.js'
import type { ReplyRecord as PrismaReplyRecord } from '../generated/prisma/client.js'

export type ReplyDeliveryPayload =
  | {
      type: 'reply_to_message'
      replyToMessageId: number
      mentionUserId?: number
    }
  | {
      type: 'send_message'
    }

export type ReplyExecutionState =
  | 'dry_run'
  | 'pending'
  | 'sending'
  | 'acked'
  | 'sent'
  | 'failed'
  | 'suppressed'
  | 'legacy_migrated'

export interface ReplyRecord {
  id: number
  runtimeKey: string
  groupId: number
  scopeKey: string
  replyIntentId: string
  sourceKind: string
  triggerMessageRowId?: number
  incorporatedMessageRowId?: number
  deliveryPayload: ReplyDeliveryPayload
  text: string
  executionState: ReplyExecutionState
  providerMessageId?: number
  attemptCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateOrReuseReplyRecordInput {
  runtimeKey: string
  groupId: number
  scopeKey: string
  replyIntentId: string
  sourceKind: string
  triggerMessageRowId?: number
  incorporatedMessageRowId?: number
  deliveryPayload: ReplyDeliveryPayload
  text: string
  executionState: Extract<ReplyExecutionState, 'dry_run' | 'pending' | 'suppressed'>
}

function mapRow(row: PrismaReplyRecord): ReplyRecord {
  return {
    id: row.id,
    runtimeKey: row.runtimeKey,
    groupId: Number(row.groupId),
    scopeKey: row.scopeKey,
    replyIntentId: row.replyIntentId,
    sourceKind: row.sourceKind,
    triggerMessageRowId: row.triggerMessageRowId ?? undefined,
    incorporatedMessageRowId: row.incorporatedMessageRowId ?? undefined,
    deliveryPayload: row.deliveryPayload as unknown as ReplyDeliveryPayload,
    text: row.text,
    executionState: row.executionState as ReplyExecutionState,
    providerMessageId: row.providerMessageId == null ? undefined : Number(row.providerMessageId),
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function findReplyRecordByReplyIntentId(
  runtimeKey: string,
  replyIntentId: string,
): Promise<ReplyRecord | null> {
  const row = await prisma.replyRecord.findUnique({
    where: {
      runtimeKey_replyIntentId: {
        runtimeKey,
        replyIntentId,
      },
    },
  })

  return row ? mapRow(row) : null
}

export async function createOrReuseReplyRecord(input: CreateOrReuseReplyRecordInput): Promise<ReplyRecord> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.replyRecord.findUnique({
      where: {
        runtimeKey_replyIntentId: {
          runtimeKey: input.runtimeKey,
          replyIntentId: input.replyIntentId,
        },
      },
    })
    if (existing) return mapRow(existing)

    const created = await tx.replyRecord.create({
      data: {
        runtimeKey: input.runtimeKey,
        groupId: BigInt(input.groupId),
        scopeKey: input.scopeKey,
        replyIntentId: input.replyIntentId,
        sourceKind: input.sourceKind,
        triggerMessageRowId: input.triggerMessageRowId ?? null,
        incorporatedMessageRowId: input.incorporatedMessageRowId ?? null,
        deliveryPayload: input.deliveryPayload as unknown as object,
        text: input.text,
        executionState: input.executionState,
        providerMessageId: null,
        attemptCount: 0,
      },
    })

    return mapRow(created)
  })
}

export async function listRecoverableReplyRecords(groupIds?: number[]): Promise<ReplyRecord[]> {
  const rows = await prisma.replyRecord.findMany({
    where: {
      executionState: {
        in: ['pending', 'sending', 'failed', 'acked'],
      },
      ...(groupIds && groupIds.length > 0 ? { groupId: { in: groupIds.map(BigInt) } } : {}),
    },
    orderBy: [
      { groupId: 'asc' },
      { scopeKey: 'asc' },
      { createdAt: 'asc' },
    ],
  })

  return rows.map((row: PrismaReplyRecord) => mapRow(row))
}

export async function listSentReplyRecords(
  groupId: number,
  scopeKey: string,
): Promise<ReplyRecord[]> {
  const rows = await prisma.replyRecord.findMany({
    where: {
      groupId: BigInt(groupId),
      scopeKey,
      executionState: 'sent',
    },
    orderBy: { createdAt: 'asc' },
  })

  return rows.map((row: PrismaReplyRecord) => mapRow(row))
}

export async function listSentReplyRecordsAfterMessageRowId(
  groupId: number,
  scopeKey: string,
  afterMessageRowId?: number,
): Promise<ReplyRecord[]> {
  const rows = await prisma.replyRecord.findMany({
    where: {
      groupId: BigInt(groupId),
      scopeKey,
      executionState: 'sent',
      ...(afterMessageRowId !== undefined
        ? { incorporatedMessageRowId: { gt: afterMessageRowId } }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
  })

  return rows.map((row: PrismaReplyRecord) => mapRow(row))
}

export async function getLatestSentReplyRecord(
  groupId: number,
  scopeKey: string,
): Promise<ReplyRecord | null> {
  const row = await prisma.replyRecord.findFirst({
    where: {
      groupId: BigInt(groupId),
      scopeKey,
      executionState: 'sent',
    },
    orderBy: { createdAt: 'desc' },
  })

  return row ? mapRow(row) : null
}

export async function markReplyRecordSending(id: number): Promise<void> {
  await prisma.replyRecord.update({
    where: { id },
    data: {
      executionState: 'sending',
      attemptCount: { increment: 1 },
    },
  })
}

export async function markReplyRecordAcked(id: number, providerMessageId: number): Promise<void> {
  await prisma.replyRecord.update({
    where: { id },
    data: {
      executionState: 'acked',
      providerMessageId: BigInt(providerMessageId),
    },
  })
}

export async function markReplyRecordSent(id: number): Promise<void> {
  await prisma.replyRecord.update({
    where: { id },
    data: { executionState: 'sent' },
  })
}

export async function markReplyRecordFailed(id: number): Promise<void> {
  await prisma.replyRecord.update({
    where: { id },
    data: { executionState: 'failed' },
  })
}

export async function markReplyRecordSuppressed(id: number): Promise<void> {
  await prisma.replyRecord.update({
    where: { id },
    data: { executionState: 'suppressed' },
  })
}

export async function upsertReplyRecordFromLegacyAssistantTurn(turn: AssistantTurnRecord): Promise<ReplyRecord> {
  const mentionUserId = turn.mentionUserId ?? parseSenderReplyScopeKey(turn.senderThreadKey) ?? undefined
  const normalizedReplyIntentId = turn.triggerMessageRowId
    ? makeMentionReplyIntentId(turn.groupId, turn.triggerMessageRowId)
    : turn.replyIntentId
  const row = await prisma.replyRecord.upsert({
    where: {
      runtimeKey_replyIntentId: {
        runtimeKey: makeGroupRuntimeKey(turn.groupId),
        replyIntentId: normalizedReplyIntentId,
      },
    },
    create: {
      runtimeKey: makeGroupRuntimeKey(turn.groupId),
      groupId: BigInt(turn.groupId),
      scopeKey: turn.senderThreadKey,
      replyIntentId: normalizedReplyIntentId,
      sourceKind: 'mention',
      triggerMessageRowId: turn.triggerMessageRowId,
      incorporatedMessageRowId: turn.incorporatedMessageRowId,
      deliveryPayload: {
        type: 'reply_to_message',
        replyToMessageId: turn.replyToMessageId,
        ...(mentionUserId != null ? { mentionUserId } : {}),
      },
      text: turn.text,
      executionState: turn.status as ReplyExecutionState,
      providerMessageId: turn.providerMessageId == null ? null : BigInt(turn.providerMessageId),
      attemptCount: turn.attemptCount,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
    },
    update: {},
  })

  return mapRow(row)
}
