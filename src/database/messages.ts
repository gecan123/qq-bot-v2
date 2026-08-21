import { prisma } from './client.js'
import { Prisma } from '../generated/prisma/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { MemoryEvidenceRow } from '../agent/memory-evidence.js'
import type { ConversationRef } from '../chat/conversation.js'

const log = createLogger('DB')

export type MessageFactKind = 'message' | 'edit' | 'recall'

export interface AppendMessageFactParams {
  eventKind: MessageFactKind
  /** 平台事件的稳定幂等键；必须能区分原消息、编辑版本和撤回。 */
  eventExternalId: string
  conversation: ConversationRef
  conversationName?: string
  mediaReferenceIds?: string[]
  messageExternalId: string
  replyToExternalId?: string
  rootExternalId?: string
  threadExternalId?: string
  senderExternalId: string
  senderName?: string
  senderConversationName?: string
  content: ParsedSegment[]
  rawContent?: unknown
  rawMessage?: string
  /** 平台事件时间（Unix 秒）。 */
  sentAt?: number
}

export interface PersistedMessageFact {
  rowId: number
  createdAt: Date
  sentAt: Date | null
}

function requireExternalId(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`appendMessageFact invariant: ${field} must not be empty`)
  return normalized
}

export function buildMessageFactUpsertReturningSql(params: AppendMessageFactParams): Prisma.Sql {
  const eventExternalId = requireExternalId(params.eventExternalId, 'eventExternalId')
  const accountId = requireExternalId(params.conversation.accountId, 'conversation.accountId')
  const conversationExternalId = requireExternalId(
    params.conversation.externalId,
    'conversation.externalId',
  )
  const messageExternalId = requireExternalId(params.messageExternalId, 'messageExternalId')
  const senderExternalId = requireExternalId(params.senderExternalId, 'senderExternalId')
  const mediaReferenceIds = params.mediaReferenceIds ?? []
  const content = sanitizeJsonValue(params.content) ?? []
  const rawContent = sanitizeJsonValue(params.rawContent)
  const searchText = segmentsToPlainText(params.content)
  const initialResolvedText = mediaReferenceIds.length > 0 ? null : searchText

  return Prisma.sql`
    INSERT INTO "messages" (
      "event_kind",
      "event_external_id",
      "platform",
      "account_id",
      "conversation_kind",
      "conversation_external_id",
      "conversation_name",
      "media_reference_ids",
      "message_external_id",
      "reply_to_external_id",
      "root_external_id",
      "thread_external_id",
      "sender_external_id",
      "sender_name",
      "sender_conversation_name",
      "content",
      "raw_content",
      "raw_message",
      "search_text",
      "resolved_text",
      "sent_at",
      "created_at"
    ) VALUES (
      ${params.eventKind},
      ${eventExternalId},
      ${params.conversation.platform},
      ${accountId},
      ${params.conversation.kind},
      ${conversationExternalId},
      ${params.conversationName ?? null},
      ${mediaReferenceIds},
      ${messageExternalId},
      ${params.replyToExternalId ?? null},
      ${params.rootExternalId ?? null},
      ${params.threadExternalId ?? null},
      ${senderExternalId},
      ${params.senderName ?? null},
      ${params.senderConversationName ?? null},
      ${jsonSql(content)},
      ${jsonSql(rawContent)},
      ${params.rawMessage ?? null},
      ${searchText},
      ${initialResolvedText},
      ${timestampSql(params.sentAt, Prisma.sql`NULL`)},
      ${timestampSql(params.sentAt, Prisma.sql`CURRENT_TIMESTAMP`)}
    )
    ON CONFLICT ("platform", "account_id", "event_external_id") DO UPDATE SET
      "event_external_id" = EXCLUDED."event_external_id"
    RETURNING row_id AS "rowId", created_at AS "createdAt", sent_at AS "sentAt"
  `
}

export async function appendMessageFact(
  params: AppendMessageFactParams,
): Promise<PersistedMessageFact> {
  const rows = await prisma.$queryRaw<PersistedMessageFact[]>(buildMessageFactUpsertReturningSql(params))
  const row = rows[0]
  if (!row) throw new Error('appendMessageFact did not return persisted row')
  log.debug({
    rowId: row.rowId,
    platform: params.conversation.platform,
    eventKind: params.eventKind,
    messageExternalId: params.messageExternalId,
  }, 'Message fact saved')
  return row
}

export async function freezeResolvedTextIfUnset(messageRowId: number, resolvedText: string): Promise<void> {
  await prisma.message.updateMany({
    where: {
      rowId: messageRowId,
      resolvedText: null,
    },
    data: { resolvedText },
  })
}

export async function findExistingMessageExternalIds(
  conversation: ConversationRef,
  messageExternalIds: readonly string[],
): Promise<Set<string>> {
  const rows = await prisma.message.findMany({
    where: {
      platform: conversation.platform,
      accountId: conversation.accountId,
      conversationKind: conversation.kind,
      conversationExternalId: conversation.externalId,
      eventKind: 'message',
      messageExternalId: { in: [...messageExternalIds] },
    },
    select: { messageExternalId: true },
  })
  return new Set(rows.map((row) => row.messageExternalId))
}

export async function findLatestMessageFact(input: {
  platform: ConversationRef['platform']
  accountId: string
  messageExternalId: string
  conversationExternalId?: string
}): Promise<{
  conversation: ConversationRef
  conversationName?: string
  senderExternalId: string
  senderName?: string
} | null> {
  const row = await prisma.message.findFirst({
    where: {
      platform: input.platform,
      accountId: input.accountId,
      messageExternalId: input.messageExternalId,
      eventKind: { in: ['message', 'edit'] },
      ...(input.conversationExternalId
        ? { conversationExternalId: input.conversationExternalId }
        : {}),
    },
    orderBy: { rowId: 'desc' },
    select: {
      conversationKind: true,
      conversationExternalId: true,
      conversationName: true,
      senderExternalId: true,
      senderName: true,
    },
  })
  if (!row) return null
  return {
    conversation: {
      platform: input.platform,
      accountId: input.accountId,
      kind: conversationKindFromDb(row.conversationKind),
      externalId: row.conversationExternalId,
    },
    ...(row.conversationName ? { conversationName: row.conversationName } : {}),
    senderExternalId: row.senderExternalId,
    ...(row.senderName ? { senderName: row.senderName } : {}),
  }
}

export async function findObservedConversations(input: {
  platform: ConversationRef['platform']
  accountId: string
}): Promise<Array<{ target: ConversationRef; displayName: string }>> {
  const rows = await prisma.message.findMany({
    where: {
      platform: input.platform,
      accountId: input.accountId,
      eventKind: { in: ['message', 'edit'] },
    },
    orderBy: { rowId: 'desc' },
    distinct: ['conversationKind', 'conversationExternalId'],
    select: {
      conversationKind: true,
      conversationExternalId: true,
      conversationName: true,
      senderName: true,
    },
  })
  return rows.map((row) => ({
    target: {
      platform: input.platform,
      accountId: input.accountId,
      kind: conversationKindFromDb(row.conversationKind),
      externalId: row.conversationExternalId,
    },
    displayName: row.conversationName ?? row.senderName ?? row.conversationExternalId,
  }))
}

export async function isObservedConversation(conversation: ConversationRef): Promise<boolean> {
  return await prisma.message.count({
    where: {
      platform: conversation.platform,
      accountId: conversation.accountId,
      conversationKind: conversation.kind,
      conversationExternalId: conversation.externalId,
      eventKind: { in: ['message', 'edit'] },
    },
  }) > 0
}

export async function isMessageInConversation(
  conversation: ConversationRef,
  messageExternalId: string,
): Promise<boolean> {
  return await prisma.message.count({
    where: {
      platform: conversation.platform,
      accountId: conversation.accountId,
      conversationKind: conversation.kind,
      conversationExternalId: conversation.externalId,
      messageExternalId,
      eventKind: { in: ['message', 'edit'] },
    },
  }) > 0
}

export async function findMemoryEvidenceRows(
  sourceMessageRowIds: readonly number[],
): Promise<MemoryEvidenceRow[]> {
  if (sourceMessageRowIds.length === 0) return []
  const rows = await prisma.message.findMany({
    where: {
      rowId: { in: [...new Set(sourceMessageRowIds)] },
      eventKind: 'message',
    },
    orderBy: { rowId: 'asc' },
    select: {
      rowId: true,
      platform: true,
      accountId: true,
      conversationKind: true,
      conversationExternalId: true,
      messageExternalId: true,
      senderExternalId: true,
      sentAt: true,
      createdAt: true,
    },
  })
  return rows.map((row) => ({
    rowId: row.rowId,
    platform: chatPlatformFromDb(row.platform),
    accountId: row.accountId,
    conversationKind: conversationKindFromDb(row.conversationKind),
    conversationExternalId: row.conversationExternalId,
    messageExternalId: row.messageExternalId,
    senderExternalId: row.senderExternalId,
    sentAt: formatBeijingIso(row.sentAt ?? row.createdAt),
  }))
}

function chatPlatformFromDb(value: string): ConversationRef['platform'] {
  if (value === 'qq' || value === 'feishu') return value
  throw new Error(`Unsupported message platform: ${value}`)
}

function conversationKindFromDb(value: string): ConversationRef['kind'] {
  if (value === 'group' || value === 'private') return value
  throw new Error(`Unsupported conversation kind: ${value}`)
}

export async function findObservedQqIdentityRows(userId: number, limit = 200): Promise<Array<{
  rowId: number
  senderNickname: string | null
  senderGroupNickname: string | null
  groupId: number | null
  groupName: string | null
  seenAt: Date
}>> {
  const rows = await prisma.message.findMany({
    where: { platform: 'qq', senderExternalId: String(userId), eventKind: 'message' },
    orderBy: { rowId: 'desc' },
    take: Math.min(Math.max(1, limit), 500),
    select: {
      rowId: true,
      senderName: true,
      senderConversationName: true,
      conversationKind: true,
      conversationExternalId: true,
      conversationName: true,
      sentAt: true,
      createdAt: true,
    },
  })
  return rows.map((row) => ({
    rowId: row.rowId,
    senderNickname: row.senderName,
    senderGroupNickname: row.senderConversationName,
    groupId: row.conversationKind === 'group' ? Number(row.conversationExternalId) : null,
    groupName: row.conversationName,
    seenAt: row.sentAt ?? row.createdAt,
  }))
}

/**
 * 判断可引用的群消息是否通过 QQ 结构化 at 明确提到了指定用户。
 * 发送授权必须基于持久化入站事实，而不是 LLM 提供的 mode 或正文猜测。
 */
export async function isConversationMessageMentioningUser(
  conversation: ConversationRef,
  messageExternalId: string,
  userExternalId: string,
): Promise<boolean> {
  if (conversation.kind !== 'group') return false
  const row = await prisma.message.findFirst({
    where: {
      platform: conversation.platform,
      accountId: conversation.accountId,
      conversationKind: 'group',
      conversationExternalId: conversation.externalId,
      eventKind: { in: ['message', 'edit'] },
      messageExternalId,
    },
    orderBy: { rowId: 'desc' },
    select: { content: true },
  })
  if (!row || !Array.isArray(row.content)) return false
  return row.content.some((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const value = segment as Record<string, unknown>
    return value.type === 'at' && value.targetId === userExternalId
  })
}

export async function findApprovalEvidenceMessage(rowId: number): Promise<{
  rowId: number
  conversation: ConversationRef
  senderExternalId: string
  text: string
  sentAt: Date
} | null> {
  const row = await prisma.message.findUnique({
    where: { rowId },
    select: {
      rowId: true,
      platform: true,
      accountId: true,
      conversationKind: true,
      conversationExternalId: true,
      senderExternalId: true,
      resolvedText: true,
      searchText: true,
      sentAt: true,
      createdAt: true,
    },
  })
  if (!row) return null
  return {
    rowId: row.rowId,
    conversation: {
      platform: chatPlatformFromDb(row.platform),
      accountId: row.accountId,
      kind: conversationKindFromDb(row.conversationKind),
      externalId: row.conversationExternalId,
    },
    senderExternalId: row.senderExternalId,
    text: row.resolvedText ?? row.searchText,
    sentAt: row.sentAt ?? row.createdAt,
  }
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
