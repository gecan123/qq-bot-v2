import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import { qqGroupSnapshotSchema, qqSnapshotSchema, type QqGroupSnapshot, type QqSnapshot } from './qq.schema.js'

type MessageRow = {
  id: number
  sceneKind: string
  sceneExternalId: string
  groupId: bigint | null
  groupName: string | null
  senderId: bigint
  senderNickname: string | null
  senderGroupNickname: string | null
  sentAt: Date | null
  createdAt: Date
  resolvedText: string | null
  searchText: string
  rawMessage: string | null
  mediaReferenceIds: string[]
}
type MediaRow = {
  mediaId: number
  data: Uint8Array
  contentType: string | null
  fileName: string | null
  fileSize: number | null
  descriptionRaw: unknown
  createdAt: Date
}
type StickerRow = { mediaId: number; name: string; tags: string[] }

const messageSelect = { id: true, sceneKind: true, sceneExternalId: true, groupId: true, groupName: true, senderId: true, senderNickname: true, senderGroupNickname: true, sentAt: true, createdAt: true, resolvedText: true, searchText: true, rawMessage: true, mediaReferenceIds: true } as const
const mediaSelect = { mediaId: true, data: true, contentType: true, fileName: true, fileSize: true, descriptionRaw: true, createdAt: true } as const

export async function loadQqSnapshot(now = new Date()): Promise<QqSnapshot> {
  const db = getAdminPrisma()
  const [messageCount, mediaCount, stickerCount, messages, media, stickers, groups] = await Promise.all([
    db.message.count(), db.media.count(), db.stickerPool.count(),
    db.message.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 80, select: messageSelect }),
    db.media.findMany({ where: { contentType: { in: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }, OR: [{ fileSize: { lte: 300_000 } }, { fileSize: null }] }, orderBy: { createdAt: 'desc' }, take: 18, select: mediaSelect }),
    db.stickerPool.findMany({ select: { mediaId: true, name: true, tags: true } }),
    readGroups(db),
  ])
  const stickerByMedia = new Map(stickers.map(item => [item.mediaId, item]))
  return qqSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), counts: { messages: messageCount, media: mediaCount, stickers: stickerCount, groups: groups.length },
    groups, messages: messages.map(mapMessage), media: media.map(row => mapMedia(row, stickerByMedia)),
    note: '总览展示最近 80 条跨会话消息；群聊列表可下钻到单群最近 300 条消息。媒体缩略图仅返回小于 300KB 的图片。',
  })
}

export async function loadQqGroupSnapshot(groupId: string, now = new Date()): Promise<QqGroupSnapshot> {
  const numericGroupId = BigInt(groupId)
  const db = getAdminPrisma()
  const [totalMessages, rows, range, stickers] = await Promise.all([
    db.message.count({ where: { sceneKind: 'qq_group', groupId: numericGroupId } }),
    db.message.findMany({ where: { sceneKind: 'qq_group', groupId: numericGroupId }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: 300, select: messageSelect }),
    db.message.aggregate({ where: { sceneKind: 'qq_group', groupId: numericGroupId }, _min: { sentAt: true, createdAt: true }, _max: { sentAt: true, createdAt: true } }),
    db.stickerPool.findMany({ select: { mediaId: true, name: true, tags: true } }),
  ])
  const mediaIds = [...new Set(rows.flatMap(row => row.mediaReferenceIds).map(mediaIdFromReference).filter((id): id is number => id !== null))].slice(0, 40)
  const media = mediaIds.length ? await db.media.findMany({ where: { mediaId: { in: mediaIds }, contentType: { in: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } }, orderBy: { createdAt: 'desc' }, take: 24, select: mediaSelect }) : []
  const stickerByMedia = new Map(stickers.map(item => [item.mediaId, item]))
  const participants = new Map<string, QqGroupSnapshot['participants'][number]>()
  for (const row of rows) {
    const senderId = row.senderId.toString()
    const at = (row.sentAt ?? row.createdAt).toISOString()
    const existing = participants.get(senderId)
    if (existing) existing.messages++
    else participants.set(senderId, { senderId, name: row.senderGroupNickname || row.senderNickname || senderId, messages: 1, lastAt: at })
  }
  const firstAt = range._min.sentAt ?? range._min.createdAt
  const lastAt = range._max.sentAt ?? range._max.createdAt
  return qqGroupSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(),
    group: { groupId, name: rows[0]?.groupName || `群 ${groupId}`, totalMessages, firstAt: firstAt?.toISOString() ?? null, lastAt: lastAt?.toISOString() ?? null, windowLimited: totalMessages > rows.length },
    participants: [...participants.values()].sort((left, right) => right.messages - left.messages),
    messages: rows.map(mapMessage), media: media.map(row => mapMedia(row, stickerByMedia)),
  })
}

async function readGroups(db: ReturnType<typeof getAdminPrisma>): Promise<QqSnapshot['groups']> {
  const rows = await db.$queryRawUnsafe<Array<{ group_id: bigint; group_name: string | null; message_count: bigint; last_at: Date }>>(`
    SELECT group_id,
      (ARRAY_AGG(group_name ORDER BY COALESCE(sent_at, created_at) DESC) FILTER (WHERE group_name IS NOT NULL))[1] AS group_name,
      COUNT(*) AS message_count,
      MAX(COALESCE(sent_at, created_at)) AS last_at
    FROM messages
    WHERE scene_kind = 'qq_group' AND group_id IS NOT NULL
    GROUP BY group_id
    ORDER BY last_at DESC
  `)
  return rows.map(row => ({ groupId: row.group_id.toString(), name: row.group_name || `群 ${row.group_id}`, messageCount: Number(row.message_count), lastAt: row.last_at.toISOString() }))
}

function mapMessage(row: MessageRow): QqSnapshot['messages'][number] {
  return { id: row.id, sceneKind: row.sceneKind, scene: row.sceneKind === 'qq_group' ? (row.groupName ? `${row.groupName} (${row.groupId})` : `群 ${row.groupId}`) : `私聊 ${row.sceneExternalId}`, sender: row.senderGroupNickname || row.senderNickname || row.senderId.toString(), senderId: row.senderId.toString(), at: (row.sentAt ?? row.createdAt).toISOString(), text: (row.resolvedText || row.searchText || row.rawMessage || '（无可读文本）').slice(0, 4_000), mediaReferenceIds: row.mediaReferenceIds }
}

function mapMedia(row: MediaRow, stickerByMedia: Map<number, StickerRow>): QqSnapshot['media'][number] {
  const sticker = stickerByMedia.get(row.mediaId)
  const contentType = row.contentType
  const mediaDescription = description(row.descriptionRaw)
  return { id: row.mediaId, contentType, fileName: row.fileName, fileSize: row.fileSize, createdAt: row.createdAt.toISOString(), description: mediaDescription.text, descriptionIsJson: mediaDescription.isJson, dataUrl: contentType && row.data.byteLength <= 300_000 ? `data:${contentType};base64,${Buffer.from(row.data).toString('base64')}` : null, stickerName: sticker?.name ?? null, stickerTags: sticker?.tags ?? [] }
}

function mediaIdFromReference(reference: string): number | null { const match = /(?:^|:)(\d+)$/.exec(reference); if (!match) return null; const value = Number(match[1]); return Number.isSafeInteger(value) && value > 0 ? value : null }
function description(value: unknown): { text: string | null; isJson: boolean } { if (typeof value === 'string') { const trimmed = value.trim(); if (trimmed.startsWith('{') || trimmed.startsWith('[')) { try { return { text: JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 4_000), isJson: true } } catch { /* plain text */ } } return { text: value.slice(0, 1_200), isJson: false } } if (!value) return { text: null, isJson: false }; try { return { text: JSON.stringify(value, null, 2).slice(0, 4_000), isJson: true } } catch { return { text: null, isJson: false } } }
