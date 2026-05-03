import { napcat } from '../bot/napcat.js'
import { createLogger } from '../logger.js'
import { previewText } from '../utils/business-log.js'

interface NapcatSegment {
  type: string
  data: Record<string, string | number | boolean>
}

export interface SendNapcatResult {
  success: boolean
  attempts: number
  providerMessageId?: number
}

const RETRY_LIMIT = 2
const RETRY_DELAY_MS = 1000
const log = createLogger('SEND')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sendGroupReply(groupId: number, segments: NapcatSegment[]): Promise<SendNapcatResult> {
  const textPreview = previewText(
    segments
      .filter((s) => s.type === 'text')
      .map((s) => String(s.data.text ?? ''))
      .join(''),
  )
  const deliveryType = segments.some((segment) => segment.type === 'reply') ? 'reply_to_message' : 'send_message'
  const segmentTypes = segments.map((segment) => segment.type)

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const result = await napcat.send_group_msg({ group_id: groupId, message: segments as never })
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          groupId,
          providerMessageId: result.message_id,
          deliveryType,
          segmentTypes,
          deliveryResult: 'sent',
          textPreview,
        },
        '消息发送成功',
      )
      return {
        success: true,
        attempts: attempt,
        providerMessageId: result.message_id,
      }
    } catch (error) {
      log.warn(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          groupId,
          deliveryType,
          segmentTypes,
          textPreview,
          attempt,
          deliveryResult: 'failed_attempt',
          error,
        },
        '消息发送失败',
      )
      if (attempt < RETRY_LIMIT) await sleep(RETRY_DELAY_MS)
    }
  }

  log.error(
    {
      direction: 'outbound',
      actor: 'bot',
      flow: 'napcat_send',
      groupId,
      deliveryType,
      deliveryResult: 'failed',
      textPreview,
    },
    `消息发送失败，已重试 ${RETRY_LIMIT} 次`,
  )
  return { success: false, attempts: RETRY_LIMIT }
}

export async function sendPrivateMessage(userId: number, segments: NapcatSegment[]): Promise<SendNapcatResult> {
  const textPreview = previewText(
    segments
      .filter((s) => s.type === 'text')
      .map((s) => String(s.data.text ?? ''))
      .join(''),
  )
  const segmentTypes = segments.map((segment) => segment.type)

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const result = await napcat.send_private_msg({ user_id: userId, message: segments as never })
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          userId,
          providerMessageId: result.message_id,
          deliveryType: 'send_private_message',
          segmentTypes,
          deliveryResult: 'sent',
          textPreview,
        },
        '私聊消息发送成功',
      )
      return {
        success: true,
        attempts: attempt,
        providerMessageId: result.message_id,
      }
    } catch (error) {
      log.warn(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          userId,
          deliveryType: 'send_private_message',
          segmentTypes,
          textPreview,
          attempt,
          deliveryResult: 'failed_attempt',
          error,
        },
        '私聊消息发送失败',
      )
      if (attempt < RETRY_LIMIT) await sleep(RETRY_DELAY_MS)
    }
  }

  log.error(
    {
      direction: 'outbound',
      actor: 'bot',
      flow: 'napcat_send',
      userId,
      deliveryType: 'send_private_message',
      deliveryResult: 'failed',
      textPreview,
    },
    `私聊消息发送失败，已重试 ${RETRY_LIMIT} 次`,
  )
  return { success: false, attempts: RETRY_LIMIT }
}
