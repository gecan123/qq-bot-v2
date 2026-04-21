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
  text: string
  status: string
  attemptCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateAssistantTurnInput {
  groupId: number
  senderThreadKey: string
  replyIntentId: string
  triggerMessageRowId: number
  incorporatedMessageRowId: number
  replyToMessageId: number
  mentionUserId?: number
  text: string
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

export async function listRecoverableAssistantTurns(groupIds?: number[]): Promise<AssistantTurnRecord[]> {
  const rows = await prisma.assistantTurn.findMany({
    where: {
      status: {
        in: ['pending', 'sending', 'failed'],
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

export async function createOrReusePendingAssistantTurn(input: CreateAssistantTurnInput): Promise<AssistantTurnRecord> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.assistantTurn.findUnique({
      where: {
        groupId_senderThreadKey_replyIntentId: {
          groupId: BigInt(input.groupId),
          senderThreadKey: input.senderThreadKey,
          replyIntentId: input.replyIntentId,
        },
      },
    })
    if (existing) return mapRow(existing)

    const latest = await tx.assistantTurn.findFirst({
      where: {
        groupId: BigInt(input.groupId),
        senderThreadKey: input.senderThreadKey,
      },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    })

    const created = await tx.assistantTurn.create({
      data: {
        groupId: BigInt(input.groupId),
        senderThreadKey: input.senderThreadKey,
        replyIntentId: input.replyIntentId,
        triggerMessageRowId: input.triggerMessageRowId,
        incorporatedMessageRowId: input.incorporatedMessageRowId,
        sequence: (latest?.sequence ?? 0) + 1,
        replyToMessageId: BigInt(input.replyToMessageId),
        mentionUserId: input.mentionUserId == null ? null : BigInt(input.mentionUserId),
        text: input.text,
        status: 'pending',
        attemptCount: 0,
      },
    })

    return mapRow(created)
  })
}

export async function markAssistantTurnSending(id: number): Promise<void> {
  await prisma.assistantTurn.update({
    where: { id },
    data: {
      status: 'sending',
      attemptCount: { increment: 1 },
    },
  })
}

export async function markAssistantTurnSent(id: number): Promise<void> {
  await prisma.assistantTurn.update({
    where: { id },
    data: { status: 'sent' },
  })
}

export async function markAssistantTurnFailed(id: number): Promise<void> {
  await prisma.assistantTurn.update({
    where: { id },
    data: { status: 'failed' },
  })
}
