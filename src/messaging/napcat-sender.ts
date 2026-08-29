import { napcat } from '../bot/napcat.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { previewText } from '../utils/business-log.js'
import { planQqFoldedText } from './qq-folded-text.js'

export interface NapcatSegment {
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
  const folded = planQqFoldedText(segments, { userId: config.selfNumber, nickname: 'Luna' })
  if (folded.kind === 'too_long') {
    log.error(
      {
        direction: 'outbound',
        actor: 'bot',
        flow: 'napcat_send',
        targetType: 'group',
        targetId: groupId,
        groupId,
        deliveryType: 'folded_message',
        deliveryResult: 'rejected',
        charCount: folded.charCount,
        maxChars: folded.maxChars,
        textPreview,
      },
      '折叠消息超过长度上限',
    )
    return { success: false, attempts: 0 }
  }
  const deliveryType = folded.kind === 'folded'
    ? 'folded_message'
    : segments.some((segment) => segment.type === 'reply') ? 'reply_to_message' : 'send_message'
  const mode = deliveryType === 'reply_to_message' ? 'reply' : 'ambient'
  const outboundSegments = folded.kind === 'folded' ? folded.nodes : segments
  const segmentTypes = outboundSegments.map((segment) => segment.type)

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const result = await napcat.send_group_msg({ group_id: groupId, message: outboundSegments as never })
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          targetType: 'group',
          targetId: groupId,
          mode,
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
          targetType: 'group',
          targetId: groupId,
          mode,
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
      targetType: 'group',
      targetId: groupId,
      mode,
      groupId,
      deliveryType,
      deliveryResult: 'failed',
      textPreview,
    },
    `消息发送失败，已重试 ${RETRY_LIMIT} 次`,
  )
  return { success: false, attempts: RETRY_LIMIT }
}

export type SendTarget =
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number }

export async function sendSegmentsRaw(target: SendTarget, segments: NapcatSegment[]): Promise<SendNapcatResult> {
  if (target.type === 'group') {
    return sendGroupReply(target.groupId, segments)
  }
  return sendPrivateMessage(target.userId, segments)
}

export async function sendPrivateMessage(userId: number, segments: NapcatSegment[]): Promise<SendNapcatResult> {
  const textPreview = previewText(
    segments
      .filter((s) => s.type === 'text')
      .map((s) => String(s.data.text ?? ''))
      .join(''),
  )
  const folded = planQqFoldedText(segments, { userId: config.selfNumber, nickname: 'Luna' })
  if (folded.kind === 'too_long') {
    log.error(
      {
        direction: 'outbound',
        actor: 'bot',
        flow: 'napcat_send',
        targetType: 'private',
        targetId: userId,
        userId,
        deliveryType: 'folded_message',
        deliveryResult: 'rejected',
        charCount: folded.charCount,
        maxChars: folded.maxChars,
        textPreview,
      },
      '折叠消息超过长度上限',
    )
    return { success: false, attempts: 0 }
  }
  const deliveryType = folded.kind === 'folded'
    ? 'folded_message'
    : segments.some((segment) => segment.type === 'reply') ? 'reply_to_message' : 'send_message'
  const mode = deliveryType === 'reply_to_message' ? 'reply' : 'ambient'
  const outboundSegments = folded.kind === 'folded' ? folded.nodes : segments
  const segmentTypes = outboundSegments.map((segment) => segment.type)

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const result = await napcat.send_private_msg({ user_id: userId, message: outboundSegments as never })
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          flow: 'napcat_send',
          targetType: 'private',
          targetId: userId,
          mode,
          userId,
          providerMessageId: result.message_id,
          deliveryType,
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
          targetType: 'private',
          targetId: userId,
          mode,
          userId,
          deliveryType,
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
      targetType: 'private',
      targetId: userId,
      mode,
      userId,
      deliveryType,
      deliveryResult: 'failed',
      textPreview,
    },
    `私聊消息发送失败，已重试 ${RETRY_LIMIT} 次`,
  )
  return { success: false, attempts: RETRY_LIMIT }
}
