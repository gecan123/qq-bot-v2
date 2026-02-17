import { napcat } from './napcat.js'
import { parseMessage } from './message-parser.js'
import { insertMessage } from '../database/messages.js'
import { config } from '../config/index.js'
import { log } from '../logger.js'
import { persistImageReferences } from '../media/image-reference.js'
import type { TextSegment } from '../types/message-segments.js'

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
    log.warn({ error, groupId: context.group_id }, '获取群名失败')
    return undefined
  }
}

export async function startBot(): Promise<void> {
  napcat.on('socket.open', () => {
    log.info('WebSocket 开始连接')
  })

  napcat.on('socket.error', (ctx) => {
    log.error({ errorType: ctx.error_type }, 'WebSocket 连接错误')
  })

  napcat.on('socket.close', (ctx) => {
    log.warn({ code: ctx.code }, 'WebSocket 连接关闭')
  })

  napcat.on('meta_event.lifecycle', (ctx) => {
    if (ctx.sub_type === 'connect') {
      log.info('NapCat 连接成功')
    }
  })

  napcat.on('api.response.failure', (ctx) => {
    log.error({ status: ctx.status, message: ctx.message }, 'API 调用失败')
  })

  napcat.on('message.group', async (context) => {
    if (!config.groupIds.includes(context.group_id)) return
    if (context.sender.user_id === config.selfNumber) return

    try {
      const qqMsg = await napcat.get_msg({ message_id: context.message_id })
      const parsed = parseMessage(qqMsg)
      const groupName = await resolveGroupName(context)
      const mediaResult = await persistImageReferences({
        content: parsed.content,
        groupId: context.group_id,
        messageId: parsed.messageId,
        senderId: parsed.senderId,
      })

      await insertMessage({
        groupId: context.group_id,
        groupName,
        imageReferenceIds: mediaResult.imageReferenceIds,
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderNickname: parsed.senderNickname,
        senderGroupNickname: parsed.senderGroupNickname,
        content: mediaResult.content,
        rawContent: qqMsg.message,
        rawMessage: qqMsg.raw_message,
      })

      const textPreview = mediaResult.content
        .filter((s): s is TextSegment => s.type === 'text')
        .map((s) => s.content)
        .join(' ')
        .slice(0, 50)

      log.info(
        {
          group: context.group_id,
          sender: parsed.senderNickname,
          segments: mediaResult.content.length,
          imageReferences: mediaResult.imageReferenceIds.length,
        },
        textPreview || `[${mediaResult.content.map((s) => s.type).join(', ')}]`
      )
    } catch (error) {
      log.error({ error, group: context.group_id, msgId: context.message_id }, '处理群消息失败')
    }
  })

  await napcat.connect()
  log.info('机器人已启动')
}
