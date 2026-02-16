import { prisma } from './client.js'
import type { Prisma } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { log } from '../logger.js'

export interface InsertMessageParams {
  groupId: number
  messageId: number
  senderId: number
  senderNickname: string
  senderGroupNickname?: string
  content: ParsedSegment[]
  rawContent?: unknown
  rawMessage?: string
}

export async function insertMessage(params: InsertMessageParams): Promise<void> {
  try {
    await prisma.message.upsert({
      where: {
        groupId_messageId: {
          groupId: BigInt(params.groupId),
          messageId: BigInt(params.messageId),
        },
      },
      create: {
        groupId: BigInt(params.groupId),
        messageId: BigInt(params.messageId),
        senderId: BigInt(params.senderId),
        senderNickname: params.senderNickname,
        senderGroupNickname: params.senderGroupNickname ?? null,
        content: params.content as unknown as Prisma.InputJsonValue,
        rawContent: (params.rawContent as Prisma.InputJsonValue) ?? undefined,
        rawMessage: params.rawMessage ?? null,
      },
      update: {},
    })
    log.debug({ messageId: params.messageId }, 'Message saved')
  } catch (error) {
    log.error({ error, messageId: params.messageId }, 'Failed to save message')
    throw error
  }
}
