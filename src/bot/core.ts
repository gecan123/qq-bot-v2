import { napcat } from './napcat.js'
import { parseMessage } from './message-parser.js'
import { findExistingMessageIds, insertMessage } from '../database/messages.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { persistMediaReferences } from '../media/media-cache.js'
import { summarizeSegments } from '../utils/business-log.js'
import { createMessageReadyDispatcher, type MessageReadyDispatcher } from './message-ready-dispatcher.js'
import { createBackfillScheduler } from './startup-backfill.js'

const ingressLog = createLogger('INGRESS')
const napcatLog = createLogger('NAPCAT')

const BACKFILL_COUNT = 50

export type IngestedMessage =
  | {
      kind: 'group'
      messageRowId: number
      groupId: number
      groupName?: string
      messageId: number
      senderId: number
      senderNickname: string
      mentionedSelf: boolean
      sentAt: Date
      renderedText: string
    }
  | {
      kind: 'private'
      messageRowId: number
      peerId: number
      messageId: number
      senderId: number
      senderNickname: string
      sentAt: Date
      renderedText: string
    }

export interface NapcatHandlerOptions {
  /**
   * 真消息从持久化 + 媒体描述 ready 之后由 ingest 调用。
   * 不传 (例如 backfill 阶段) 表示「只入库, 不进 LLM 视野」。
   */
  onMessageReady?: (input: IngestedMessage) => void | Promise<void>
}

export interface NapcatHandlerLifecycle {
  initialBackfillDone: Promise<void>
  drain(): Promise<void>
}

interface ProcessMessageOptions extends NapcatHandlerOptions {
  readyDispatcher?: MessageReadyDispatcher
}

type Scope =
  | { kind: 'group'; groupId: number }
  | { kind: 'private'; peerId: number }

async function processMessage(
  scope: Scope,
  messageId: number,
  options: ProcessMessageOptions,
): Promise<void> {
  const qqMsg = await napcat.get_msg({ message_id: messageId })
  const parsed = parseMessage(qqMsg)
  if (parsed.senderId === config.selfNumber) {
    ingressLog.debug({ scope, messageId: parsed.messageId }, '忽略 bot 自身回灌消息')
    return
  }

  const groupName =
    scope.kind === 'group'
      ? await resolveGroupName({ group_id: scope.groupId, ...qqMsg })
      : undefined

  const mediaResult = await persistMediaReferences({
    content: parsed.content,
    scope,
    messageId: parsed.messageId,
    senderId: parsed.senderId,
    napcat,
  })

  const persisted = await insertMessage(
    scope.kind === 'group'
      ? {
          sceneKind: 'qq_group',
          groupId: scope.groupId,
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
        }
      : {
          sceneKind: 'qq_private',
          sceneExternalId: String(scope.peerId),
          groupId: null,
          mediaReferenceIds: mediaResult.mediaReferenceIds,
          messageId: parsed.messageId,
          senderId: parsed.senderId,
          senderNickname: parsed.senderNickname,
          content: mediaResult.content,
          rawContent: qqMsg.message,
          rawMessage: qqMsg.raw_message,
          sentAt: parsed.time,
        },
  )

  const mentionedSelf = mediaResult.content.some(
    (segment) => segment.type === 'at' && segment.targetId === String(config.selfNumber),
  )

  if (scope.kind === 'group') {
    ingressLog.info(
      {
        direction: 'inbound',
        flow: 'group_message_ingress',
        groupId: scope.groupId,
        groupName,
        messageId: parsed.messageId,
        messageRowId: persisted.id,
        senderId: parsed.senderId,
        senderNickname: parsed.senderGroupNickname ?? parsed.senderNickname,
        mentionedSelf,
        ...summarizeSegments(mediaResult.content),
        mediaReferences: mediaResult.mediaReferenceIds.length,
      },
      '群消息已入库',
    )
  } else {
    ingressLog.info(
      {
        direction: 'inbound',
        flow: 'private_message_ingress',
        peerId: scope.peerId,
        messageId: parsed.messageId,
        messageRowId: persisted.id,
        senderId: parsed.senderId,
        senderNickname: parsed.senderNickname,
        ...summarizeSegments(mediaResult.content),
        mediaReferences: mediaResult.mediaReferenceIds.length,
      },
      '私聊消息已入库',
    )
  }

  if (scope.kind === 'group') {
    options.readyDispatcher?.schedule({
      kind: 'group',
      messageRowId: persisted.id,
      groupId: scope.groupId,
      groupName,
      messageId: parsed.messageId,
      senderId: parsed.senderId,
      senderNickname: parsed.senderGroupNickname ?? parsed.senderNickname,
      mentionedSelf,
      sentAt: persisted.sentAt ?? persisted.createdAt,
    })
  } else {
    options.readyDispatcher?.schedule({
      kind: 'private',
      messageRowId: persisted.id,
      peerId: scope.peerId,
      messageId: parsed.messageId,
      senderId: parsed.senderId,
      senderNickname: parsed.senderNickname,
      sentAt: persisted.sentAt ?? persisted.createdAt,
    })
  }
}

async function backfillGroupMessages(groupId: number): Promise<void> {
  const { messages } = await napcat.get_group_msg_history({
    group_id: groupId,
    count: BACKFILL_COUNT,
  })
  const allMessageIds = messages.map((m) => m.message_id)
  const existingIds = await findExistingMessageIds(groupId, allMessageIds)

  for (const msg of messages) {
    if (existingIds.has(msg.message_id)) continue
    try {
      // backfill 不传 onMessageReady, 历史消息只入库, 不进 LLM 视野。
      // 启动恢复只覆盖 mailbox cursor / legacy lastWakeAt 边界后的消息。
      await processMessage({ kind: 'group', groupId }, msg.message_id, {})
    } catch (error) {
      ingressLog.warn({ error, groupId, msgId: msg.message_id }, '补拉消息处理失败,跳过')
    }
  }
  ingressLog.info(
    {
      flow: 'group_message_backfill',
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

/**
 * 注册 NapCat 事件 handler. 同步, 不做 I/O, 不发起 connect.
 * 调用方必须随后调 connectNapcat() 才会真正开 WebSocket.
 *
 * 拆 register / connect 两步是为了让 index.ts 可以:
 *   register handlers → connect → await initial backfill barrier → resolve metadata →
 *   replay missed (按 rowId 去重) → build system prompt → start agent.
 *
 * 关键: connect 之后, NapCat 收到的实时消息会立刻走 onMessageReady (经过去重).
 *       replay-missed 在 connect 之后跑也安全, 因为它们共享 messageRowId 去重.
 */
export function registerNapcatHandlers(options: NapcatHandlerOptions = {}): NapcatHandlerLifecycle {
  const readyDispatcher = createMessageReadyDispatcher({ onMessageReady: options.onMessageReady })
  const backfillScheduler = createBackfillScheduler(async () => {
    await Promise.all(config.botTargetGroupIds.map(async (groupId) => {
      try {
        await backfillGroupMessages(groupId)
      } catch (error) {
        ingressLog.error({ error, groupId }, '群历史消息补拉失败')
      }
    }))
  })

  napcat.on('socket.open', () => napcatLog.info('WebSocket 开始连接'))
  napcat.on('socket.error', (ctx) => napcatLog.error({ errorType: ctx.error_type }, 'WebSocket 连接错误'))
  napcat.on('socket.close', (ctx) => napcatLog.warn({ code: ctx.code }, 'WebSocket 连接关闭'))

  napcat.on('meta_event.lifecycle', async (ctx) => {
    if (ctx.sub_type === 'connect') {
      napcatLog.info('NapCat 连接成功')
      void backfillScheduler.schedule()
    }
  })

  napcat.on('api.response.failure', (ctx) => {
    napcatLog.error({ status: ctx.status, message: ctx.message }, 'API 调用失败')
  })

  const groupChains = new Map<number, Promise<void>>()

  napcat.on('message.group', (context) => {
    if (!config.botTargetGroupIds.includes(context.group_id)) return
    const groupId = context.group_id
    const prev = groupChains.get(groupId) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await processMessage({ kind: 'group', groupId }, context.message_id, { ...options, readyDispatcher })
      } catch (error) {
        ingressLog.error({ error, group: groupId, msgId: context.message_id }, '处理群消息失败')
      }
    })
    groupChains.set(groupId, next)
  })

  const privateChains = new Map<number, Promise<void>>()

  napcat.on('message.private', (context) => {
    if (context.sub_type !== 'friend') return
    const peerId = context.user_id
    const prev = privateChains.get(peerId) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await processMessage({ kind: 'private', peerId }, context.message_id, { ...options, readyDispatcher })
      } catch (error) {
        ingressLog.error({ error, peer: peerId, msgId: context.message_id }, '处理私聊消息失败')
      }
    })
    privateChains.set(peerId, next)
  })

  return {
    initialBackfillDone: backfillScheduler.initialBackfillDone,
    async drain() {
      await Promise.all([backfillScheduler.drain(), readyDispatcher.drain()])
    },
  }
}

/**
 * 真正打开 NapCat WebSocket. 必须在 registerNapcatHandlers() 之后调.
 *
 * 在此之后才能调用任何 NapCat API (get_group_info / get_stranger_info 等).
 */
export async function connectNapcat(): Promise<void> {
  await napcat.connect()
  napcatLog.info(
    {
      groupIds: config.botTargetGroupIds,
    },
    'NapCat 监听已启动',
  )
}
