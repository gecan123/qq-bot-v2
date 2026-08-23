import type { NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk'
import { appendMessageFact, type AppendMessageFactParams } from '../database/messages.js'
import { computeMediaHash } from '../media/media-hash.js'
import { createMediaFromBytes, type CreateMediaFromBytesInput } from '../media/media-store.js'
import { requestMediaDescription } from './media-worker-client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { withTransientRetry } from '../database/transient-retry.js'

export const FEISHU_MEDIA_MAX_BYTES = 20 * 1024 * 1024

export interface FeishuIngressInput {
  accountId: string
  eventId: string
  eventKind?: 'message' | 'edit'
  conversationName?: string
  message: NormalizedMessage
}

export interface FeishuIngressDeps {
  downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Buffer>
  createMedia?: (input: CreateMediaFromBytesInput) => Promise<number>
  describeMedia?: (mediaId: number) => void
  appendFact?: (input: AppendMessageFactParams) => ReturnType<typeof appendMessageFact>
}

export async function persistFeishuIncomingMessage(
  input: FeishuIngressInput,
  deps: FeishuIngressDeps,
) {
  const content: ParsedSegment[] = []
  const mediaReferenceIds: string[] = []
  if (input.message.replyToMessageId) {
    content.push({ type: 'reply', messageId: input.message.replyToMessageId })
  }
  if (input.message.content.trim()) {
    content.push({ type: 'text', content: input.message.content })
  }
  for (const mention of input.message.mentions) {
    const targetId = mention.openId ?? mention.userId
    if (targetId) content.push({ type: 'at', targetId, ...(mention.name ? { targetName: mention.name } : {}) })
  }
  for (const resource of input.message.resources) {
    const persisted = await persistResource(input.message.messageId, resource, deps)
    content.push(persisted.segment)
    if (persisted.referenceId) mediaReferenceIds.push(persisted.referenceId)
  }
  if (input.message.mentionAll) {
    content.push({ type: 'at', targetId: 'all', targetName: '所有人' })
  }
  if (content.length === 0) {
    content.push({ type: 'raw', originalType: input.message.rawContentType, data: input.message.raw ?? null })
  }

  const fact: AppendMessageFactParams = {
    eventKind: input.eventKind ?? 'message',
    eventExternalId: input.eventId,
    conversation: {
      platform: 'feishu',
      accountId: input.accountId,
      kind: input.message.chatType === 'p2p' ? 'private' : 'group',
      externalId: input.message.chatId,
    },
    ...(input.conversationName ? { conversationName: input.conversationName } : {}),
    mediaReferenceIds,
    messageExternalId: input.message.messageId,
    ...(input.message.replyToMessageId ? { replyToExternalId: input.message.replyToMessageId } : {}),
    ...(input.message.rootId ? { rootExternalId: input.message.rootId } : {}),
    ...(input.message.threadId ? { threadExternalId: input.message.threadId } : {}),
    senderExternalId: input.message.senderId,
    ...(input.message.senderName ? { senderName: input.message.senderName } : {}),
    content,
    rawContent: input.message.raw ?? input.message,
    rawMessage: input.message.content,
    sentAt: Math.floor(input.message.createTime / 1000),
  }
  return withTransientRetry(() => (deps.appendFact ?? appendMessageFact)(fact))
}

async function persistResource(
  messageId: string,
  resource: ResourceDescriptor,
  deps: FeishuIngressDeps,
): Promise<{ segment: ParsedSegment; referenceId?: string }> {
  let bytes: Buffer
  try {
    bytes = await deps.downloadResource(
      messageId,
      resource.fileKey,
      resource.type === 'image' || resource.type === 'sticker' ? 'image' : 'file',
    )
  } catch {
    return {
      segment: {
        type: 'text',
        content: `[${resourceLabel(resource)}: ${resource.fileName ?? resource.fileKey}，下载失败，未保存]`,
      },
    }
  }
  if (bytes.byteLength > FEISHU_MEDIA_MAX_BYTES) {
    return {
      segment: {
        type: 'text',
        content: `[${resourceLabel(resource)}: ${resource.fileName ?? resource.fileKey}，超过 20MB，未保存]`,
      },
    }
  }
  const mediaId = await (deps.createMedia ?? createMediaFromBytes)({
    bytes,
    dataHash: computeMediaHash(bytes),
    mediaType: mediaType(resource),
    ...(resource.fileName ? { fileName: resource.fileName } : {}),
  })
  if (resource.type === 'image' || resource.type === 'sticker') {
    if (deps.describeMedia) deps.describeMedia(mediaId)
    else void requestMediaDescription(mediaId, { priority: 'low' })
  }
  const referenceId = String(mediaId)
  return {
    referenceId,
    segment: mediaSegment(resource, referenceId, bytes.byteLength),
  }
}

function mediaSegment(resource: ResourceDescriptor, referenceId: string, size: number): ParsedSegment {
  const base = {
    referenceId,
    ...(resource.fileName ? { fileName: resource.fileName } : {}),
    fileSize: String(size),
  }
  if (resource.type === 'image' || resource.type === 'sticker') return { type: 'image', ...base }
  if (resource.type === 'video') return { type: 'video', ...base }
  if (resource.type === 'audio') return { type: 'record', ...base }
  return { type: 'file', fileId: resource.fileKey, ...base }
}

function mediaType(resource: ResourceDescriptor): string {
  if (resource.type === 'audio') return 'record'
  return resource.type
}

function resourceLabel(resource: ResourceDescriptor): string {
  return resource.type === 'image' ? '图片' : resource.type === 'file' ? '文件' : '媒体'
}
