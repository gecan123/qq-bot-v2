import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import { qqGroupSnapshotSchema, qqSnapshotSchema, type QqGroupSnapshot, type QqSnapshot } from './qq.schema.js'

type MessageRow = {
  rowId: number
  platform: string
  accountId: string
  conversationKind: string
  conversationExternalId: string
  conversationName: string | null
  senderExternalId: string
  senderName: string | null
  senderConversationName: string | null
  sentAt: Date | null
  createdAt: Date
  resolvedText: string | null
  searchText: string
  rawMessage: string | null
  mediaReferenceIds: string[]
}
type MediaRow = {
  mediaId: number
  contentType: string | null
  fileName: string | null
  fileSize: number | null
  descriptionRaw: unknown
  createdAt: Date
  blob: {
    data: Uint8Array
    byteSize: number
  } | null
}
type StickerRow = { mediaId: number; name: string; tags: string[] }

const messageSelect = {
  rowId: true,
  platform: true,
  accountId: true,
  conversationKind: true,
  conversationExternalId: true,
  conversationName: true,
  senderExternalId: true,
  senderName: true,
  senderConversationName: true,
  sentAt: true,
  createdAt: true,
  resolvedText: true,
  searchText: true,
  rawMessage: true,
  mediaReferenceIds: true,
} as const
const mediaSelect = { mediaId: true, contentType: true, fileName: true, fileSize: true, descriptionRaw: true, createdAt: true, blob: { select: { data: true, byteSize: true } } } as const

export async function loadQqSnapshot(now = new Date()): Promise<QqSnapshot> {
  const db = getAdminPrisma()
  const [messageCount, mediaCount, stickerCount, messages, media, stickers, conversations] = await Promise.all([
    db.message.count(),
    db.media.count(),
    db.stickerPool.count(),
    db.message.findMany({
      orderBy: [{ createdAt: 'desc' }, { rowId: 'desc' }],
      take: 80,
      select: messageSelect,
    }),
    db.media.findMany({ where: { contentType: { in: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }, blob: { is: { byteSize: { lte: 300_000 } } } }, orderBy: { createdAt: 'desc' }, take: 18, select: mediaSelect }),
    db.stickerPool.findMany({ select: { mediaId: true, name: true, tags: true } }),
    readConversations(db),
  ])
  const stickerByMedia = new Map(stickers.map(item => [item.mediaId, item]))
  return qqSnapshotSchema.parse({
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    counts: { messages: messageCount, media: mediaCount, stickers: stickerCount, conversations: conversations.length },
    conversations,
    messages: messages.map(mapMessage),
    media: media.map(row => mapMedia(row, stickerByMedia)),
    note: '总览展示最近 80 条跨平台消息；QQ 群可继续下钻。媒体是 QQ / 飞书共享事实缓存，缩略图仅返回小于 300KB 的图片。',
  })
}

export async function loadQqGroupSnapshot(groupId: string, now = new Date()): Promise<QqGroupSnapshot> {
  const db = getAdminPrisma()
  const where = {
    platform: 'qq',
    conversationKind: 'group',
    conversationExternalId: groupId,
  } as const
  const [totalMessages, rows, range, stickers] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [{ sentAt: 'desc' }, { rowId: 'desc' }],
      take: 300,
      select: messageSelect,
    }),
    db.message.aggregate({
      where,
      _min: { sentAt: true, createdAt: true },
      _max: { sentAt: true, createdAt: true },
    }),
    db.stickerPool.findMany({ select: { mediaId: true, name: true, tags: true } }),
  ])
  const mediaIds = [...new Set(rows.flatMap(row => row.mediaReferenceIds).map(mediaIdFromReference).filter((id): id is number => id !== null))].slice(0, 40)
  const media = mediaIds.length ? await db.media.findMany({ where: { mediaId: { in: mediaIds }, contentType: { in: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }, blob: { isNot: null } }, orderBy: { createdAt: 'desc' }, take: 24, select: mediaSelect }) : []
  const stickerByMedia = new Map(stickers.map(item => [item.mediaId, item]))
  const participants = new Map<string, QqGroupSnapshot['participants'][number]>()
  for (const row of rows) {
    const senderId = row.senderExternalId
    const at = (row.sentAt ?? row.createdAt).toISOString()
    const existing = participants.get(senderId)
    if (existing) existing.messages++
    else participants.set(senderId, {
      senderId,
      name: row.senderConversationName || row.senderName || senderId,
      messages: 1,
      lastAt: at,
    })
  }
  const firstAt = range._min?.sentAt ?? range._min?.createdAt ?? null
  const lastAt = range._max?.sentAt ?? range._max?.createdAt ?? null
  return qqGroupSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    group: {
      groupId,
      name: rows[0]?.conversationName || `群 ${groupId}`,
      totalMessages,
      firstAt: firstAt?.toISOString() ?? null,
      lastAt: lastAt?.toISOString() ?? null,
      windowLimited: totalMessages > rows.length,
    },
    participants: [...participants.values()].sort((left, right) => right.messages - left.messages),
    messages: rows.map(mapMessage),
    media: media.map(row => mapMedia(row, stickerByMedia)),
  })
}

async function readConversations(db: ReturnType<typeof getAdminPrisma>): Promise<QqSnapshot['conversations']> {
  const rows = await db.$queryRawUnsafe<Array<{
    platform: 'qq' | 'feishu'
    account_id: string
    conversation_kind: 'group' | 'private'
    external_id: string
    conversation_name: string | null
    message_count: bigint
    last_at: Date
  }>>(`
    SELECT platform, account_id, conversation_kind,
      conversation_external_id AS external_id,
      (ARRAY_AGG(conversation_name ORDER BY COALESCE(sent_at, created_at) DESC)
        FILTER (WHERE conversation_name IS NOT NULL))[1] AS conversation_name,
      COUNT(*) AS message_count,
      MAX(COALESCE(sent_at, created_at)) AS last_at
    FROM messages
    GROUP BY platform, account_id, conversation_kind, conversation_external_id
    ORDER BY last_at DESC
  `)
  return rows.map(row => ({
    platform: row.platform,
    accountId: row.account_id,
    kind: row.conversation_kind,
    externalId: row.external_id,
    name: row.conversation_name || row.external_id,
    messageCount: Number(row.message_count),
    lastAt: row.last_at.toISOString(),
  }))
}

function mapMessage(row: MessageRow): QqSnapshot['messages'][number] {
  const sceneKind = `${row.platform}_${row.conversationKind}`
  return {
    id: row.rowId,
    platform: row.platform === 'feishu' ? 'feishu' : 'qq',
    accountId: row.accountId,
    conversationKind: row.conversationKind === 'private' ? 'private' : 'group',
    conversationExternalId: row.conversationExternalId,
    sceneKind,
    scene: row.conversationKind === 'group'
      ? (row.conversationName
          ? `${row.conversationName} (${row.conversationExternalId})`
          : `群 ${row.conversationExternalId}`)
      : `私聊 ${row.conversationExternalId}`,
    sender: row.senderConversationName || row.senderName || row.senderExternalId,
    senderId: row.senderExternalId,
    at: (row.sentAt ?? row.createdAt).toISOString(),
    text: (row.resolvedText || row.searchText || row.rawMessage || '（无可读文本）').slice(0, 4_000),
    mediaReferenceIds: row.mediaReferenceIds,
  }
}

function mapMedia(row: MediaRow, stickerByMedia: Map<number, StickerRow>): QqSnapshot['media'][number] {
  const sticker = stickerByMedia.get(row.mediaId)
  const contentType = row.contentType
  const mediaDescription = description(row.descriptionRaw)
  return {
    id: row.mediaId,
    contentType,
    fileName: row.fileName,
    fileSize: row.fileSize ?? row.blob?.byteSize ?? null,
    createdAt: row.createdAt.toISOString(),
    description: mediaDescription.text,
    descriptionIsJson: mediaDescription.isJson,
    dataUrl: contentType && row.blob && row.blob.byteSize <= 300_000
      ? `data:${contentType};base64,${Buffer.from(row.blob.data).toString('base64')}`
      : null,
    stickerName: sticker?.name ?? null,
    stickerTags: sticker?.tags ?? [],
  }
}

function mediaIdFromReference(reference: string): number | null { const match = /(?:^|:)(\d+)$/.exec(reference); if (!match) return null; const value = Number(match[1]); return Number.isSafeInteger(value) && value > 0 ? value : null }
function description(value: unknown): { text: string | null; isJson: boolean } { if (typeof value === 'string') { const trimmed = value.trim(); if (trimmed.startsWith('{') || trimmed.startsWith('[')) { try { return { text: JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 4_000), isJson: true } } catch { /* plain text */ } } return { text: value.slice(0, 1_200), isJson: false } } if (!value) return { text: null, isJson: false }; try { return { text: JSON.stringify(value, null, 2).slice(0, 4_000), isJson: true } } catch { return { text: null, isJson: false } } }
