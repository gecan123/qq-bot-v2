import { prisma } from '../database/client.js'

export interface AssistantTurnRecord {
  id: number
  groupId: number
  senderThreadKey: string
  replyIntentId: string
  triggerMessageRowId: number
  incorporatedMessageRowId: number
  sequence: number
  replyToMessageId: number
  mentionUserId?: number
  providerMessageId?: number
  text: string
  status: string
  attemptCount: number
  createdAt: Date
  updatedAt: Date
}

function mapRow(row: Awaited<ReturnType<typeof prisma.assistantTurn.findUnique>> extends infer T
  ? T extends null ? never : T
  : never): AssistantTurnRecord {
  return {
    id: row.id,
    groupId: Number(row.groupId),
    senderThreadKey: row.senderThreadKey,
    replyIntentId: row.replyIntentId,
    triggerMessageRowId: row.triggerMessageRowId,
    incorporatedMessageRowId: row.incorporatedMessageRowId,
    sequence: row.sequence,
    replyToMessageId: Number(row.replyToMessageId),
    mentionUserId: row.mentionUserId == null ? undefined : Number(row.mentionUserId),
    providerMessageId: row.providerMessageId == null ? undefined : Number(row.providerMessageId),
    text: row.text,
    status: row.status,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listSentAssistantTurns(groupId: number, senderThreadKey: string): Promise<AssistantTurnRecord[]> {
  const rows = await prisma.assistantTurn.findMany({
    where: {
      groupId: BigInt(groupId),
      senderThreadKey,
      status: 'sent',
    },
    orderBy: { sequence: 'asc' },
  })

  return rows.map((row) => mapRow(row))
}

export async function getLatestSentAssistantTurn(
  groupId: number,
  senderThreadKey: string,
): Promise<AssistantTurnRecord | null> {
  const row = await prisma.assistantTurn.findFirst({
    where: {
      groupId: BigInt(groupId),
      senderThreadKey,
      status: 'sent',
    },
    orderBy: { sequence: 'desc' },
  })

  return row ? mapRow(row) : null
}

export async function listRecoverableAssistantTurns(groupIds?: number[]): Promise<AssistantTurnRecord[]> {
  const rows = await prisma.assistantTurn.findMany({
    where: {
      status: {
        in: ['pending', 'sending', 'failed', 'acked'],
      },
      ...(groupIds && groupIds.length > 0 ? { groupId: { in: groupIds.map(BigInt) } } : {}),
    },
    orderBy: [
      { groupId: 'asc' },
      { senderThreadKey: 'asc' },
      { sequence: 'asc' },
    ],
  })

  return rows.map((row) => mapRow(row))
}

export async function listLegacyAssistantTurns(groupIds?: number[]): Promise<AssistantTurnRecord[]> {
  const rows = await prisma.assistantTurn.findMany({
    where: {
      ...(groupIds && groupIds.length > 0 ? { groupId: { in: groupIds.map(BigInt) } } : {}),
    },
    orderBy: [
      { groupId: 'asc' },
      { senderThreadKey: 'asc' },
      { sequence: 'asc' },
    ],
  })

  return rows.map((row) => mapRow(row))
}

export async function listSentAssistantTurnsAfterMessageRowId(
  groupId: number,
  senderThreadKey: string,
  afterMessageRowId?: number,
): Promise<AssistantTurnRecord[]> {
  const rows = await prisma.assistantTurn.findMany({
    where: {
      groupId: BigInt(groupId),
      senderThreadKey,
      status: 'sent',
      ...(afterMessageRowId !== undefined ? { incorporatedMessageRowId: { gt: afterMessageRowId } } : {}),
    },
    orderBy: { sequence: 'asc' },
  })

  return rows.map((row) => mapRow(row))
}

export async function findAssistantTurnByReplyIntentId(
  groupId: number,
  senderThreadKey: string,
  replyIntentId: string,
): Promise<AssistantTurnRecord | null> {
  const row = await prisma.assistantTurn.findUnique({
    where: {
      groupId_senderThreadKey_replyIntentId: {
        groupId: BigInt(groupId),
        senderThreadKey,
        replyIntentId,
      },
    },
  })

  return row ? mapRow(row) : null
}

/**
 * Phase 1.5 清理:
 * - 历史上 assistant_turns 是 bot 回复的 ledger, 但 reply-executor / action-executor
 *   早已切到 action_records, assistant_turns 没有 live writer。
 * - 此文件只保留 legacy 迁移相关的 reader (listLegacyAssistantTurns 等),
 *   给 reply-record-migration 用; writer (createOrReusePendingAssistantTurn /
 *   markAssistantTurnSending / Acked / Sent / Failed) 已删除。
 * - assistantTurn schema 仍保留, 因为旧数据可能存在, migration 路径还在用它。
 */
