import { prisma } from './client.js'
import { Prisma } from '../generated/prisma/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { createLogger } from '../logger.js'

const log = createLogger('DB')

export type MessageSceneKind = 'qq_group' | 'qq_private'

export interface InsertMessageParams {
  sceneKind?: MessageSceneKind
  sceneExternalId?: string | number
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

function resolveMessageScene(params: { sceneKind?: MessageSceneKind; sceneExternalId?: string | number; groupId: number }) {
  const sceneKind = params.sceneKind ?? 'qq_group'
  const sceneExternalId = String(params.sceneExternalId ?? params.groupId)
  return { sceneKind, sceneExternalId }
}

export interface PersistedMessageInsertResult {
  id: number
  createdAt: Date
  sentAt: Date | null
}

export async function freezeResolvedTextIfUnset(messageId: number, resolvedText: string): Promise<void> {
  await prisma.message.updateMany({
    where: {
      id: messageId,
      resolvedText: null,
    },
    data: { resolvedText },
  })
}

export async function getGroupMessages(groupId: number, limit: number): Promise<Message[]> {
  return prisma.message.findMany({
    where: { groupId: BigInt(groupId), sceneKind: 'qq_group' },
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
    sceneKind: 'qq_group',
    ...(beforeMessageId !== undefined ? { messageId: { lt: BigInt(beforeMessageId) } } : {}),
  }
  const rows = await prisma.message.findMany({
    where,
    orderBy: { messageId: 'desc' },
    take: limit,
  })
  return rows.reverse()
}

export async function getGroupMessagesAfterRowId(
  groupId: number,
  afterRowId?: number,
): Promise<Message[]> {
  return prisma.message.findMany({
    where: {
      groupId: BigInt(groupId),
      sceneKind: 'qq_group',
      ...(afterRowId !== undefined ? { id: { gt: afterRowId } } : {}),
    },
    orderBy: { id: 'asc' },
  })
}

export async function getSceneMessagesAfterRowId(
  sceneKind: MessageSceneKind,
  sceneExternalId: string | number,
  afterRowId?: number,
): Promise<Message[]> {
  return prisma.message.findMany({
    where: {
      sceneKind,
      sceneExternalId: String(sceneExternalId),
      ...(afterRowId !== undefined ? { id: { gt: afterRowId } } : {}),
    },
    orderBy: { id: 'asc' },
  })
}

export async function getRecentSceneMessages(
  sceneKind: MessageSceneKind,
  sceneExternalId: string | number,
  limit: number,
  beforeMessageId?: number,
): Promise<Message[]> {
  const rows = await prisma.message.findMany({
    where: {
      sceneKind,
      sceneExternalId: String(sceneExternalId),
      ...(beforeMessageId !== undefined ? { messageId: { lt: BigInt(beforeMessageId) } } : {}),
    },
    orderBy: { messageId: 'desc' },
    take: limit,
  })
  return rows.reverse()
}

export async function getLatestGroupMessageRowId(groupId: number): Promise<number | undefined> {
  const row = await prisma.message.findFirst({
    where: {
      groupId: BigInt(groupId),
      sceneKind: 'qq_group',
    },
    orderBy: { id: 'desc' },
    select: { id: true },
  })

  return row?.id
}

export async function getMessageById(groupId: number, messageId: number): Promise<Message | null> {
  return prisma.message.findFirst({
    where: {
      sceneKind: 'qq_group',
      sceneExternalId: String(groupId),
      messageId: BigInt(messageId),
    },
  })
}

export async function getMessageBySceneMessageId(input: {
  sceneKind: MessageSceneKind
  sceneExternalId: string | number
  messageId: number
}): Promise<Message | null> {
  return prisma.message.findFirst({
    where: {
      sceneKind: input.sceneKind,
      sceneExternalId: String(input.sceneExternalId),
      messageId: BigInt(input.messageId),
    },
  })
}

export async function findExistingMessageIds(groupId: number, messageIds: number[]): Promise<Set<number>> {
  const rows = await prisma.message.findMany({
    where: {
      groupId: BigInt(groupId),
      sceneKind: 'qq_group',
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
  const scene = resolveMessageScene(params)
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const searchText = segmentsToPlainText(params.content)
  const initialResolvedText = mediaReferenceIds.length > 0 ? null : searchText
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
      "scene_kind",
      "scene_external_id",
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
      "resolved_text",
      "sent_at",
      "created_at"
    ) VALUES (
      ${scene.sceneKind},
      ${scene.sceneExternalId},
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
      ${initialResolvedText},
      ${timestampSql(params.sentAt, Prisma.sql`NULL`)},
      ${timestampSql(params.sentAt, Prisma.sql`CURRENT_TIMESTAMP`)}
    )
    ON CONFLICT ("scene_kind", "scene_external_id", "message_id") DO UPDATE SET
    ${Prisma.join(updates, ', ')}
  `
}

export function buildMessageUpsertReturningSql(params: InsertMessageParams): Prisma.Sql {
  return Prisma.sql`${buildMessageUpsertSql(params)} RETURNING id, created_at AS "createdAt", sent_at AS "sentAt"`
}

export async function insertMessage(params: InsertMessageParams): Promise<PersistedMessageInsertResult> {
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const content = sanitizeJsonValue(params.content) ?? []
  const rawContent = sanitizeJsonValue(params.rawContent)

  try {
    const rows = await prisma.$queryRaw<PersistedMessageInsertResult[]>(buildMessageUpsertReturningSql(params))
    const row = rows[0]
    if (!row) {
      throw new Error('insertMessage did not return persisted row')
    }
    log.debug({ messageId: params.messageId, imageReferences: mediaReferenceIds.length }, 'Message saved')
    return row
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
