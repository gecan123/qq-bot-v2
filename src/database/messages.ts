import { prisma } from './client.js'
import type { Prisma, Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { log } from '../logger.js'

export interface InsertMessageParams {
  groupId: number
  groupName?: string
  mediaReferenceIds?: string[]
  messageId: number
  senderId: number
  senderNickname: string
  senderGroupNickname?: string
  content: ParsedSegment[]
  rawContent?: unknown
  rawMessage?: string
}

export async function getGroupMessages(groupId: number, limit: number): Promise<Message[]> {
  return prisma.message.findMany({
    where: { groupId: BigInt(groupId) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

export async function getRecentGroupMessages(groupId: number, limit: number): Promise<Message[]> {
  return prisma.message.findMany({
    where: { groupId: BigInt(groupId) },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

export async function getMessageById(groupId: number, messageId: number): Promise<Message | null> {
  return prisma.message.findUnique({
    where: {
      groupId_messageId: {
        groupId: BigInt(groupId),
        messageId: BigInt(messageId),
      },
    },
  })
}

export async function findExistingMessageIds(groupId: number, messageIds: number[]): Promise<Set<number>> {
  const rows = await prisma.message.findMany({
    where: {
      groupId: BigInt(groupId),
      messageId: { in: messageIds.map(BigInt) },
    },
    select: { messageId: true },
  })
  return new Set(rows.map((r) => Number(r.messageId)))
}

export async function insertMessage(params: InsertMessageParams): Promise<void> {
  const mediaReferenceIds = params.mediaReferenceIds ?? []

  try {
    await prisma.message.upsert({
      where: {
        groupId_messageId: {
          groupId: BigInt(params.groupId),
          messageId: BigInt(params.messageId),
        },
      },
      create: {
        groupId: BigInt(params.groupId),
        groupName: params.groupName ?? null,
        mediaReferenceIds,
        messageId: BigInt(params.messageId),
        senderId: BigInt(params.senderId),
        senderNickname: params.senderNickname,
        senderGroupNickname: params.senderGroupNickname ?? null,
        content: params.content as unknown as Prisma.InputJsonValue,
        rawContent: (params.rawContent as Prisma.InputJsonValue) ?? undefined,
        rawMessage: params.rawMessage ?? null,
      },
      update: {
        groupName: params.groupName ?? null,
        mediaReferenceIds,
      },
    })
    log.debug({ messageId: params.messageId, imageReferences: mediaReferenceIds.length }, 'Message saved')
  } catch (error) {
    log.error({ error, messageId: params.messageId }, 'Failed to save message')
    throw error
  }
}
