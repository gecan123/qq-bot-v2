import { prisma } from './client.js'
import { Prisma } from '../generated/prisma/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('DB')

export type MessageSceneKind = 'qq_group' | 'qq_private'

export interface InsertMessageParams {
  sceneKind?: MessageSceneKind
  sceneExternalId?: string | number
  /**
   * 群消息: QQ 群号 (必填). 私聊: 必须传 null (持久化 group_id 列也是 null).
   * 历史/默认 sceneKind='qq_group' 时仍要求非 null.
   */
  groupId: number | null
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

interface ResolvedScene {
  sceneKind: MessageSceneKind
  sceneExternalId: string
  groupIdValue: bigint | null
}

function resolveMessageScene(params: InsertMessageParams): ResolvedScene {
  const sceneKind: MessageSceneKind = params.sceneKind ?? 'qq_group'

  if (sceneKind === 'qq_group') {
    if (params.groupId == null) {
      throw new Error('insertMessage invariant: sceneKind=qq_group requires non-null groupId')
    }
    const externalIdInput = params.sceneExternalId
    const sceneExternalId = externalIdInput == null ? '' : String(externalIdInput)
    if (sceneExternalId !== '') {
      throw new Error('insertMessage invariant: sceneKind=qq_group requires sceneExternalId="" (got non-empty)')
    }
    return {
      sceneKind,
      sceneExternalId,
      groupIdValue: BigInt(params.groupId),
    }
  }

  // qq_private
  if (params.groupId != null) {
    throw new Error('insertMessage invariant: sceneKind=qq_private requires groupId=null')
  }
  if (params.sceneExternalId == null || String(params.sceneExternalId).trim() === '') {
    throw new Error('insertMessage invariant: sceneKind=qq_private requires non-empty sceneExternalId (peerId)')
  }
  return {
    sceneKind,
    sceneExternalId: String(params.sceneExternalId),
    groupIdValue: null,
  }
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

/**
 * 判断可引用的群消息是否通过 QQ 结构化 at 明确提到了指定用户。
 * 发送授权必须基于持久化入站事实，而不是 LLM 提供的 mode 或正文猜测。
 */
export async function isGroupMessageMentioningUser(
  groupId: number,
  messageId: number,
  userId: number,
): Promise<boolean> {
  const row = await prisma.message.findUnique({
    where: {
      sceneKind_sceneExternalId_messageId: {
        sceneKind: 'qq_group',
        sceneExternalId: '',
        messageId: BigInt(messageId),
      },
    },
    select: { groupId: true, content: true },
  })
  if (row?.groupId !== BigInt(groupId) || !Array.isArray(row.content)) return false
  return row.content.some((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const value = segment as Record<string, unknown>
    return value.type === 'at' && value.targetId === String(userId)
  })
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
    return formatBeijingIso(value)
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
      ${scene.groupIdValue},
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
