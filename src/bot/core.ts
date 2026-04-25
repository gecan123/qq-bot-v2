import { napcat } from './napcat.js'
import { parseMessage } from './message-parser.js'
import { findExistingMessageIds, insertMessage } from '../database/messages.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { persistMediaReferences } from '../media/media-cache.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { RootRuntimeManager } from '../runtime/root-runtime.js'
import { summarizeSegments, type BusinessLogDispatchMode, type BusinessLogIngestSource } from '../utils/business-log.js'

const ingressLog = createLogger('INGRESS')
const napcatLog = createLogger('NAPCAT')

const BACKFILL_COUNT = 50

interface ProcessMessageOptions {
  dispatchMention?: boolean
  ingestSource?: BusinessLogIngestSource
  rootRuntime?: RootRuntimeManager
}

type FinalizePersistedMessageOptions = {
  groupId: number
  messageId: number
  messageRowId: number
  senderId: number
  senderNickname: string
  createdAt: number
  segments: ParsedSegment[]
  dispatchMention?: boolean
  rootRuntime?: RootRuntimeManager
  persistedCreatedAt: Date
  ingestSource?: BusinessLogIngestSource
}

export async function finalizePersistedGroupMessage(
  options: FinalizePersistedMessageOptions,
): Promise<void> {
  await options.rootRuntime?.emitRuntimeEvent({
    eventKind: 'group_message',
    groupId: options.groupId,
    createdAt: options.persistedCreatedAt,
    message: {
      groupId: options.groupId,
      messageRowId: options.messageRowId,
      messageId: options.messageId,
      senderId: options.senderId,
      senderNickname: options.senderNickname,
      segments: options.segments,
      createdAt: options.persistedCreatedAt,
    },
  }, {
    executeDecisions: options.dispatchMention !== false,
    ingestSource: options.ingestSource,
  })
}

async function processMessage(groupId: number, messageId: number, options: ProcessMessageOptions = {}): Promise<void> {
  const ingestSource = options.ingestSource ?? 'realtime'
  const dispatchMode: BusinessLogDispatchMode = options.dispatchMention === false ? 'snapshot_only' : 'live'
  const qqMsg = await napcat.get_msg({ message_id: messageId })
  const parsed = parseMessage(qqMsg)
  if (parsed.senderId === config.selfNumber) {
    ingressLog.debug({ groupId, messageId: parsed.messageId, ingestSource }, '忽略 bot 自身回灌消息')
    return
  }
  const groupName = await resolveGroupName({ group_id: groupId, ...qqMsg })
  const mediaResult = await persistMediaReferences({
    content: parsed.content,
    groupId,
    messageId: parsed.messageId,
    senderId: parsed.senderId,
    napcat,
  })

  const persistedMessage = await insertMessage({
    groupId,
    groupName,
    mediaReferenceIds: mediaResult.mediaReferenceIds,
    messageId: parsed.messageId,
    senderId: parsed.senderId,
    senderNickname: parsed.senderNickname,
    senderGroupNickname: parsed.senderGroupNickname,
    content: mediaResult.content,
    rawContent: qqMsg.message,
    rawMessage: qqMsg.raw_message,
    sentAt: parsed.time,
  })

  const mentionedSelf = mediaResult.content.some(
    (segment) => segment.type === 'at' && segment.targetId === String(config.selfNumber),
  )
  const logPersistedMessage = ingestSource === 'backfill' ? ingressLog.debug : ingressLog.info
  logPersistedMessage(
    {
      direction: 'inbound',
      actor: 'member',
      category: mentionedSelf ? 'mention' : 'ambient_message',
      flow: ingestSource === 'backfill' ? 'group_message_backfill' : 'group_message_ingress',
      ingestSource,
      dispatchMode,
      sideEffect: 'db_write',
      groupId,
      groupName,
      messageId: parsed.messageId,
      messageRowId: persistedMessage.id,
      senderId: parsed.senderId,
      senderNickname: parsed.senderGroupNickname ?? parsed.senderNickname,
      ...summarizeSegments(mediaResult.content),
      mediaReferences: mediaResult.mediaReferenceIds.length,
    },
    ingestSource === 'backfill' ? '历史群消息已入库' : '群友消息已入库',
  )

  await finalizePersistedGroupMessage({
    groupId,
    messageId: parsed.messageId,
    messageRowId: persistedMessage.id,
    senderId: parsed.senderId,
    senderNickname: parsed.senderGroupNickname ?? parsed.senderNickname,
    createdAt: parsed.time * 1000,
    segments: mediaResult.content,
    dispatchMention: options.dispatchMention,
    ingestSource,
    rootRuntime: options.rootRuntime,
    persistedCreatedAt: persistedMessage.sentAt ?? persistedMessage.createdAt,
  })
}

async function backfillGroupMessages(groupId: number, options: ProcessMessageOptions = {}): Promise<void> {
  const { messages } = await napcat.get_group_msg_history({
    group_id: groupId,
    count: BACKFILL_COUNT,
  })

  const allMessageIds = messages.map((m) => m.message_id)
  const existingIds = await findExistingMessageIds(groupId, allMessageIds)

  for (const msg of messages) {
    if (existingIds.has(msg.message_id)) continue
    try {
      await processMessage(groupId, msg.message_id, {
        ...options,
        dispatchMention: false,
        ingestSource: 'backfill',
      })
    } catch (error) {
      ingressLog.warn(
        {
          error,
          groupId,
          msgId: msg.message_id,
          ingestSource: 'backfill',
          dispatchMode: 'snapshot_only',
        },
        '补拉消息处理失败，跳过',
      )
    }
  }
  ingressLog.info(
    {
      direction: 'inbound',
      actor: 'system',
      category: 'group_message',
      flow: 'group_message_backfill',
      ingestSource: 'backfill',
      dispatchMode: 'snapshot_only',
      sideEffect: 'db_write',
      groupId,
      total: messages.length,
      skipped: existingIds.size,
      inserted: messages.length - existingIds.size,
    },
    '历史消息补拉完成',
  )
}

function getGroupNameFromEvent(context: { group_name?: string; groupName?: string }): string | undefined {
  if (!context || typeof context !== 'object') return undefined

  const candidate = context.group_name ?? context.groupName

  if (typeof candidate !== 'string') return undefined
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : undefined
}

async function resolveGroupName(context: { group_id: number; group_name?: string; groupName?: string }): Promise<string | undefined> {
  const eventGroupName = getGroupNameFromEvent(context)
  if (eventGroupName) return eventGroupName

  try {
    const groupInfo = await napcat.get_group_info({ group_id: context.group_id })
    const apiGroupName = groupInfo.group_name?.trim()
    return apiGroupName ? apiGroupName : undefined
  } catch (error) {
    napcatLog.warn({ error, groupId: context.group_id }, '获取群名失败')
    return undefined
  }
}

export interface StartBotOptions {
  rootRuntime?: RootRuntimeManager
}

export async function startBot(options: StartBotOptions = {}): Promise<void> {
  napcat.on('socket.open', () => {
    napcatLog.info('WebSocket 开始连接')
  })

  napcat.on('socket.error', (ctx) => {
    napcatLog.error({ errorType: ctx.error_type }, 'WebSocket 连接错误')
  })

  napcat.on('socket.close', (ctx) => {
    napcatLog.warn({ code: ctx.code }, 'WebSocket 连接关闭')
  })

  napcat.on('meta_event.lifecycle', async (ctx) => {
    if (ctx.sub_type === 'connect') {
      napcatLog.info('NapCat 连接成功')
      for (const groupId of config.groupIds) {
        backfillGroupMessages(groupId, {
          rootRuntime: options.rootRuntime,
        }).catch((error) => {
          ingressLog.error({ error, groupId, ingestSource: 'backfill' }, '群历史消息补拉失败')
        })
      }
    }
  })

  napcat.on('api.response.failure', (ctx) => {
    napcatLog.error({ status: ctx.status, message: ctx.message }, 'API 调用失败')
  })

  napcat.on('message.group', async (context) => {
    if (!config.groupIds.includes(context.group_id)) return

    try {
      await processMessage(context.group_id, context.message_id, {
        dispatchMention: true,
        ingestSource: 'realtime',
        rootRuntime: options.rootRuntime,
      })
    } catch (error) {
      ingressLog.error({ error, group: context.group_id, msgId: context.message_id, ingestSource: 'realtime' }, '处理群消息失败')
    }
  })

  await napcat.connect()
  napcatLog.info('NapCat 监听已启动')
}
