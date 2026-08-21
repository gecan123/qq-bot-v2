import { prisma } from './client.js'
import { getMessageTimestamp } from '../utils/message-time.js'

export interface SearchResult {
  messageId: number
  senderId: number
  senderName: string
  time: string
  text: string
}

export async function searchMessages(
  groupId: number,
  keyword: string,
  limit: number,
): Promise<SearchResult[]> {
  const rows = await prisma.message.findMany({
    where: {
      platform: 'qq',
      conversationKind: 'group',
      conversationExternalId: String(groupId),
      eventKind: 'message',
      searchText: { contains: keyword, mode: 'insensitive' },
    },
    orderBy: { rowId: 'desc' },
    take: limit,
    select: {
      messageExternalId: true,
      senderExternalId: true,
      senderName: true,
      senderConversationName: true,
      searchText: true,
      sentAt: true,
      createdAt: true,
    },
  })

  return rows
    .map((r) => ({
      messageId: Number(r.messageExternalId),
      senderId: Number(r.senderExternalId),
      senderName: r.senderConversationName ?? r.senderName ?? r.senderExternalId,
      time: getMessageTimestamp(r).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      text: r.searchText,
    }))
    .reverse()
}

export interface MemberLookupResult {
  senderId: number
  senderNickname: string | null
  senderGroupNickname: string | null
}

export async function lookupGroupMember(
  groupId: number,
  name: string,
): Promise<MemberLookupResult[]> {
  const rows = await prisma.message.findMany({
    where: {
      platform: 'qq',
      conversationKind: 'group',
      conversationExternalId: String(groupId),
      eventKind: 'message',
      OR: [
        { senderName: { contains: name, mode: 'insensitive' } },
        { senderConversationName: { contains: name, mode: 'insensitive' } },
      ],
    },
    take: 10,
    distinct: ['senderExternalId'],
    orderBy: { createdAt: 'desc' },
    select: {
      senderExternalId: true,
      senderName: true,
      senderConversationName: true,
    },
  })

  return rows.map((r) => ({
    senderId: Number(r.senderExternalId),
    senderNickname: r.senderName,
    senderGroupNickname: r.senderConversationName,
  }))
}
