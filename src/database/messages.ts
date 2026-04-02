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

function jsonSql(value: Prisma.InputJsonValue | null | undefined): Prisma.Sql {
  if (value === undefined) return Prisma.sql`NULL`
  if (value === null) return Prisma.sql`'null'::jsonb`
  return Prisma.sql`CAST(${JSON.stringify(value)} AS jsonb)`
}

function timestampSql(unixSeconds: number | undefined, fallback: Prisma.Sql): Prisma.Sql {
  if (unixSeconds === undefined) return fallback
  return Prisma.sql`to_timestamp(${unixSeconds})`
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

export function buildMessageUpsertSql(params: InsertMessageParams): Prisma.Sql {
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const searchText = segmentsToPlainText(params.content)
  const content = sanitizeJsonValue(params.content) ?? []
  const rawContent = sanitizeJsonValue(params.rawContent)
  const updates: Prisma.Sql[] = [
    Prisma.sql`"group_name" = ${params.groupName ?? null}`,
    Prisma.sql`"media_reference_ids" = ${mediaReferenceIds}`,
    Prisma.sql`"sender_nickname" = ${params.senderNickname}`,
    Prisma.sql`"sender_group_nickname" = ${params.senderGroupNickname ?? null}`,
    Prisma.sql`"content" = ${jsonSql(content)}`,
    Prisma.sql`"search_text" = ${searchText}`,
  ]

  if (params.rawContent !== undefined) {
    updates.push(Prisma.sql`"raw_content" = ${jsonSql(rawContent)}`)
  }

  if (params.rawMessage !== undefined) {
    updates.push(Prisma.sql`"raw_message" = ${params.rawMessage}`)
  }

  if (params.sentAt !== undefined) {
    updates.push(Prisma.sql`"sent_at" = ${timestampSql(params.sentAt, Prisma.sql`NULL`)}`)
  }

  return Prisma.sql`
    INSERT INTO "messages" (
      "group_id",
      "group_name",
      "media_reference_ids",
      "message_id",
      "sender_id",
      "sender_nickname",
      "sender_group_nickname",
      "content",
      "raw_content",
      "raw_message",
      "search_text",
      "sent_at",
      "created_at"
    ) VALUES (
      ${BigInt(params.groupId)},
      ${params.groupName ?? null},
      ${mediaReferenceIds},
      ${BigInt(params.messageId)},
      ${BigInt(params.senderId)},
      ${params.senderNickname},
      ${params.senderGroupNickname ?? null},
      ${jsonSql(content)},
      ${jsonSql(rawContent)},
      ${params.rawMessage ?? null},
      ${searchText},
      ${timestampSql(params.sentAt, Prisma.sql`NULL`)},
      ${timestampSql(params.sentAt, Prisma.sql`CURRENT_TIMESTAMP`)}
    )
    ON CONFLICT ("group_id", "message_id") DO UPDATE SET
    ${Prisma.join(updates, ', ')}
  `
}

export async function insertMessage(params: InsertMessageParams): Promise<void> {
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const content = sanitizeJsonValue(params.content) ?? []
  const rawContent = sanitizeJsonValue(params.rawContent)

  try {
    await prisma.$executeRaw(buildMessageUpsertSql(params))
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
