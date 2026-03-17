import { prisma } from './client.js'
import type { GroupMemory, UserMemory } from '../generated/prisma/client.js'

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
      createdAt: true,
    },
  })

  return rows
    .map((r) => ({
      messageId: Number(r.messageId),
      senderId: Number(r.senderId),
      senderName: r.senderGroupNickname ?? r.senderNickname ?? String(r.senderId),
      time: r.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      text: r.searchText,
    }))
    .reverse()
}

export async function getUserProfile(groupId: number, senderId: number): Promise<UserMemory | null> {
  return prisma.userMemory.findUnique({
    where: { groupId_senderId: { groupId: BigInt(groupId), senderId: BigInt(senderId) } },
  })
}

export async function getGroupSummary(groupId: number): Promise<GroupMemory | null> {
  return prisma.groupMemory.findUnique({ where: { groupId: BigInt(groupId) } })
}
