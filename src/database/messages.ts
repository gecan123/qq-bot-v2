import { prisma } from './client.js'
import { Prisma } from '../generated/prisma/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
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
  /** QQ 消息发送时间（Unix 秒） */
  sentAt?: number
}

export async function getGroupMessages(groupId: number, limit: number): Promise<Message[]> {
  return prisma.message.findMany({
    where: { groupId: BigInt(groupId) },
    orderBy: { messageId: 'desc' },
    take: limit,
  })
}

export async function getRecentGroupMessages(
  groupId: number,
  limit: number,
  beforeMessageId?: number,
): Promise<Message[]> {
  const where: Prisma.MessageWhereInput = {
    groupId: BigInt(groupId),
    ...(beforeMessageId !== undefined ? { messageId: { lt: BigInt(beforeMessageId) } } : {}),
  }
  const rows = await prisma.message.findMany({
    where,
    orderBy: { messageId: 'desc' },
    take: limit,
  })
  return rows.reverse()
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

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
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
    return value.map((item) => sanitizeJsonValue(item) ?? null)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, sanitizeJsonValue(item)] as const)
      .filter(([, item]) => item !== undefined)

    return Object.fromEntries(entries)
  }

  return String(value)
}

export async function insertMessage(params: InsertMessageParams): Promise<void> {
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const searchText = segmentsToPlainText(params.content)
  const content = sanitizeJsonValue(params.content)
  const rawContent = sanitizeJsonValue(params.rawContent)

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
        content: (content ?? []) as Prisma.InputJsonValue,
        rawContent: rawContent === null ? Prisma.JsonNull : rawContent,
        rawMessage: params.rawMessage ?? null,
        searchText,
        sentAt: params.sentAt !== undefined ? new Date(params.sentAt * 1000) : null,
      },
      update: {
        groupName: params.groupName ?? null,
        mediaReferenceIds,
        searchText,
      },
    })
    log.debug({ messageId: params.messageId, imageReferences: mediaReferenceIds.length }, 'Message saved')
  } catch (error) {
    log.error(
      {
        error,
        messageId: params.messageId,
        payload: {
          groupId: params.groupId,
          mediaReferenceIds,
          content,
          rawContent,
        },
      },
      'Failed to save message'
    )
    throw error
  }
}
