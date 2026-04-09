import { prisma } from './client.js'
import type { GroupMemory, GroupMemoryCursor, UserMemory } from '../generated/prisma/client.js'

export type { GroupMemory, GroupMemoryCursor, UserMemory }

export async function getGroupMemory(groupId: bigint): Promise<GroupMemory | null> {
  return prisma.groupMemory.findUnique({ where: { groupId } })
}

export interface SaveGroupMemoryParams {
  groupId: bigint
  groupName: string | null
  summary: string
}

export async function saveGroupMemory(params: SaveGroupMemoryParams): Promise<void> {
  await prisma.groupMemory.upsert({
    where: { groupId: params.groupId },
    create: params,
    update: {
      groupName: params.groupName,
      summary: params.summary,
    },
  })
}

export async function getGroupMemoryCursor(groupId: bigint): Promise<GroupMemoryCursor | null> {
  return prisma.groupMemoryCursor.findUnique({ where: { groupId } })
}

export interface SaveGroupMemoryCursorParams {
  groupId: bigint
  lastProcessedExternalMessageId: bigint
  lastProcessedMessageRowId: number
}

export async function saveGroupMemoryCursor(params: SaveGroupMemoryCursorParams): Promise<void> {
  await prisma.groupMemoryCursor.upsert({
    where: { groupId: params.groupId },
    create: params,
    update: {
      lastProcessedExternalMessageId: params.lastProcessedExternalMessageId,
      lastProcessedMessageRowId: params.lastProcessedMessageRowId,
    },
  })
}

export async function getUserMemory(groupId: bigint, senderId: bigint): Promise<UserMemory | null> {
  return prisma.userMemory.findUnique({
    where: { groupId_senderId: { groupId, senderId } },
  })
}

export async function getUserMemories(groupId: bigint, senderIds: bigint[]): Promise<UserMemory[]> {
  if (senderIds.length === 0) return []
  return prisma.userMemory.findMany({
    where: { groupId, senderId: { in: senderIds } },
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
