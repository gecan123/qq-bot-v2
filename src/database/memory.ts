import { prisma } from './client.js'
import type { GroupMemory, UserMemory } from '../generated/prisma/client.js'

export type { GroupMemory, UserMemory }

export async function getGroupMemory(groupId: bigint): Promise<GroupMemory | null> {
  return prisma.groupMemory.findUnique({ where: { groupId } })
}

export interface UpsertGroupMemoryParams {
  groupId: bigint
  groupName: string | null
  summary: string
  lastMessageId: bigint
}

export async function upsertGroupMemory(params: UpsertGroupMemoryParams): Promise<void> {
  await prisma.groupMemory.upsert({
    where: { groupId: params.groupId },
    create: params,
    update: {
      groupName: params.groupName,
      summary: params.summary,
      lastMessageId: params.lastMessageId,
    },
  })
}

export async function getUserMemory(groupId: bigint, senderId: bigint): Promise<UserMemory | null> {
  return prisma.userMemory.findUnique({
    where: { groupId_senderId: { groupId, senderId } },
  })
}

export interface UpsertUserMemoryParams {
  groupId: bigint
  groupName: string | null
  senderId: bigint
  senderNickname: string | null
  senderGroupNickname: string | null
  profile: string
  examples: string[]
}

export async function upsertUserMemory(params: UpsertUserMemoryParams): Promise<void> {
  await prisma.userMemory.upsert({
    where: { groupId_senderId: { groupId: params.groupId, senderId: params.senderId } },
    create: params,
    update: {
      groupName: params.groupName,
      senderNickname: params.senderNickname,
      senderGroupNickname: params.senderGroupNickname,
      profile: params.profile,
      examples: params.examples,
    },
  })
}
