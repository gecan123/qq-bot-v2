import { prisma } from '../database/client.js'

export interface ConversationStateRecord {
  id: number
  groupId: number
  senderThreadKey: string
  compactedBase: string
  compactedVersion: number
  lastCompactedMessageRowId?: number
  createdAt: Date
  updatedAt: Date
}

function mapRow(row: Awaited<ReturnType<typeof prisma.conversationState.findUnique>> extends infer T
  ? T extends null ? never : T
  : never): ConversationStateRecord {
  return {
    id: row.id,
    groupId: Number(row.groupId),
    senderThreadKey: row.senderThreadKey,
    compactedBase: row.compactedBase,
    compactedVersion: row.compactedVersion,
    lastCompactedMessageRowId: row.lastCompactedMessageRowId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getOrCreateConversationState(
  groupId: number,
  senderThreadKey: string,
): Promise<ConversationStateRecord> {
  const row = await prisma.conversationState.upsert({
    where: {
      groupId_senderThreadKey: {
        groupId: BigInt(groupId),
        senderThreadKey,
      },
    },
    create: {
      groupId: BigInt(groupId),
      senderThreadKey,
    },
    update: {},
  })

  return mapRow(row)
}

export async function listConversationStatesByGroupIds(groupIds: number[]): Promise<ConversationStateRecord[]> {
  if (groupIds.length === 0) return []

  const rows = await prisma.conversationState.findMany({
    where: {
      groupId: { in: groupIds.map(BigInt) },
    },
    orderBy: [
      { groupId: 'asc' },
      { senderThreadKey: 'asc' },
    ],
  })

  return rows.map((row) => mapRow(row))
}

export async function compactConversationState(params: {
  groupId: number
  senderThreadKey: string
  compactedBase: string
  lastCompactedMessageRowId: number
}): Promise<void> {
  await prisma.conversationState.upsert({
    where: {
      groupId_senderThreadKey: {
        groupId: BigInt(params.groupId),
        senderThreadKey: params.senderThreadKey,
      },
    },
    create: {
      groupId: BigInt(params.groupId),
      senderThreadKey: params.senderThreadKey,
      compactedBase: params.compactedBase,
      lastCompactedMessageRowId: params.lastCompactedMessageRowId,
    },
    update: {
      compactedBase: params.compactedBase,
      compactedVersion: { increment: 1 },
      lastCompactedMessageRowId: params.lastCompactedMessageRowId,
    },
  })
}
