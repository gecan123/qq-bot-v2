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
      groupId: BigInt(groupId),
      searchText: { contains: keyword, mode: 'insensitive' },
    },
    orderBy: { messageId: 'desc' },
    take: limit,
    select: {
      messageId: true,
      senderId: true,
      senderNickname: true,
      senderGroupNickname: true,
      searchText: true,
      sentAt: true,
      createdAt: true,
    },
  })

  return rows
    .map((r) => ({
      messageId: Number(r.messageId),
      senderId: Number(r.senderId),
      senderName: r.senderGroupNickname ?? r.senderNickname ?? String(r.senderId),
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
      groupId: BigInt(groupId),
      OR: [
        { senderNickname: { contains: name, mode: 'insensitive' } },
        { senderGroupNickname: { contains: name, mode: 'insensitive' } },
      ],
    },
    take: 10,
    distinct: ['senderId'],
    orderBy: { createdAt: 'desc' },
    select: { senderId: true, senderNickname: true, senderGroupNickname: true },
  })

  return rows.map((r) => ({
    senderId: Number(r.senderId),
    senderNickname: r.senderNickname,
    senderGroupNickname: r.senderGroupNickname,
  }))
}
