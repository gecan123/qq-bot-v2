import { napcat } from './napcat.js'
import { parseMessage } from './message-parser.js'
import { findExistingMessageIds, insertMessage } from '../database/messages.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { persistMediaReferences } from '../media/media-cache.js'
import { ensureMessageReadyForAgent } from '../media/ensure-message-ready.js'
import { prisma } from '../database/client.js'
import { summarizeSegments } from '../utils/business-log.js'

const ingressLog = createLogger('INGRESS')
const napcatLog = createLogger('NAPCAT')

const BACKFILL_COUNT = 50

export interface IngestedMessage {
  messageRowId: number
  groupId: number
  messageId: number
  senderId: number
  senderNickname: string
  mentionedSelf: boolean
  sentAt: Date
  renderedText: string
}

export interface StartBotOptions {
  /**
   * 真消息从持久化 + 媒体描述 ready 之后由 ingest 调用。
   * Phase 2 wiring 把它接到 BotEventQueue.enqueue。
   * 不传 (例如 backfill 阶段) 表示「只入库, 不进 LLM 视野」。
   */
  onMessageReady?: (input: IngestedMessage) => void | Promise<void>
}

async function processGroupMessage(
  groupId: number,
  messageId: number,
  options: StartBotOptions,
): Promise<void> {
  const qqMsg = await napcat.get_msg({ message_id: messageId })
  const parsed = parseMessage(qqMsg)
  if (parsed.senderId === config.selfNumber) {
    ingressLog.debug({ groupId, messageId: parsed.messageId }, '忽略 bot 自身回灌消息')
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

  const persisted = await insertMessage({
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

  ingressLog.info(
    {
      direction: 'inbound',
      flow: 'group_message_ingress',
      groupId,
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

  if (!options.onMessageReady) return

  // 等媒体描述就绪 + 渲染成 LLM 可见文本 + 冻结 resolved_text
  const messageRow = await prisma.message.findUnique({ where: { id: persisted.id } })
  if (!messageRow) return
  const ready = await ensureMessageReadyForAgent(messageRow)

  await options.onMessageReady({
    messageRowId: persisted.id,
    groupId,
    messageId: parsed.messageId,
    senderId: parsed.senderId,
    senderNickname: parsed.senderGroupNickname ?? parsed.senderNickname,
    mentionedSelf,
    sentAt: persisted.sentAt ?? persisted.createdAt,
    renderedText: ready.renderedText,
  })
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
      // 启动恢复路径 (replay-missed) 已经覆盖了 lastWakeAt 之后该入 LLM 的部分。
      await processGroupMessage(groupId, msg.message_id, {})
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

export async function startBot(options: StartBotOptions = {}): Promise<void> {
  napcat.on('socket.open', () => napcatLog.info('WebSocket 开始连接'))
  napcat.on('socket.error', (ctx) => napcatLog.error({ errorType: ctx.error_type }, 'WebSocket 连接错误'))
  napcat.on('socket.close', (ctx) => napcatLog.warn({ code: ctx.code }, 'WebSocket 连接关闭'))

  napcat.on('meta_event.lifecycle', async (ctx) => {
    if (ctx.sub_type === 'connect') {
      napcatLog.info('NapCat 连接成功')
      backfillGroupMessages(config.botTargetGroupId).catch((error) => {
        ingressLog.error({ error, groupId: config.botTargetGroupId }, '群历史消息补拉失败')
      })
    }
  })

  napcat.on('api.response.failure', (ctx) => {
    napcatLog.error({ status: ctx.status, message: ctx.message }, 'API 调用失败')
  })

  napcat.on('message.group', async (context) => {
    if (context.group_id !== config.botTargetGroupId) return
    try {
      await processGroupMessage(context.group_id, context.message_id, options)
    } catch (error) {
      ingressLog.error({ error, group: context.group_id, msgId: context.message_id }, '处理群消息失败')
    }
  })

  await napcat.connect()
  napcatLog.info({ targetGroup: config.botTargetGroupId }, 'NapCat 监听已启动')
}
