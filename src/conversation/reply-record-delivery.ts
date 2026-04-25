import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import {
  markReplyRecordAcked,
  markReplyRecordFailed,
  markReplyRecordSending,
  markReplyRecordSent,
  type ReplyRecord,
} from './reply-record-store.js'
import { createReplyAudit } from './reply-audit-store.js'
import { previewText } from '../utils/business-log.js'

const log = createLogger('REPLY_RECORD')

export interface ReplyRecordDeliveryDependencies {
  sender?: MessageSender
  replyRecordStore?: {
    markAcked: typeof markReplyRecordAcked
    markSending: typeof markReplyRecordSending
    markSent: typeof markReplyRecordSent
    markFailed: typeof markReplyRecordFailed
  }
  replyAuditStore?: {
    create: typeof createReplyAudit
  }
}

export type ReplyRecordDeliveryResult = 'sent' | 'failed' | 'dry_run' | 'skipped'

function isReplyPayload(
  payload: ReplyRecord['deliveryPayload'],
): payload is Extract<ReplyRecord['deliveryPayload'], { type: 'reply_to_message' }> {
  return payload.type === 'reply_to_message'
}

export async function deliverReplyRecord(
  record: ReplyRecord,
  options: ReplyRecordDeliveryDependencies = {},
): Promise<ReplyRecordDeliveryResult> {
  if (record.executionState === 'sent') return 'sent'
  if (record.executionState === 'dry_run') return 'dry_run'

  const sender = options.sender ?? messageSender
  const replyRecordStore = options.replyRecordStore ?? {
    markAcked: markReplyRecordAcked,
    markSending: markReplyRecordSending,
    markSent: markReplyRecordSent,
    markFailed: markReplyRecordFailed,
  }
  const replyAuditStore = options.replyAuditStore ?? {
    create: createReplyAudit,
  }

  const shouldDryRun = isReplyPayload(record.deliveryPayload)
    ? (sender.isReplyDryRunEnabled?.() ?? false)
    : (sender.isSendDryRunEnabled?.() ?? false)

  if (shouldDryRun) {
    await replyAuditStore.create({
      runtimeKey: record.runtimeKey,
      groupId: record.groupId,
      scopeKey: record.scopeKey,
      replyIntentId: record.replyIntentId,
      auditKind: 'dry_run',
      payload: {
        deliveryType: record.deliveryPayload.type,
        text: record.text,
      },
    })
    log.info(
      {
        direction: 'outbound',
        actor: 'bot',
        category: 'reply_delivery',
        flow: 'reply_record_delivery',
        groupId: record.groupId,
        scopeKey: record.scopeKey,
        replyIntentId: record.replyIntentId,
        sourceKind: record.sourceKind,
        deliveryType: record.deliveryPayload.type,
        dispatchMode: 'dry_run',
        sideEffect: 'audit_write',
        deliveryResult: 'dry_run',
        textPreview: previewText(record.text),
      },
      '投递跳过（dry run）',
    )
    return 'dry_run'
  }

  let sendSucceeded = false

  try {
    if (record.providerMessageId == null && record.executionState !== 'acked') {
      await replyRecordStore.markSending(record.id)

      const sendResult = isReplyPayload(record.deliveryPayload)
        ? await sender.replyToMessage({
            groupId: record.groupId,
            replyToMessageId: record.deliveryPayload.replyToMessageId ?? record.deliveryPayload.messageId ?? 0,
            mentionUserId: record.deliveryPayload.mentionUserId,
            text: record.text,
          })
        : await sender.sendMessage({
            groupId: record.groupId,
            text: record.text,
          })

      if (!sendResult.success) {
        await replyRecordStore.markFailed(record.id)
        return 'failed'
      }

      if (sendResult.providerMessageId != null) {
        await replyRecordStore.markAcked(record.id, sendResult.providerMessageId)
      }

      sendSucceeded = true
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          category: 'reply_delivery',
          flow: 'reply_record_delivery',
          groupId: record.groupId,
          scopeKey: record.scopeKey,
          replyIntentId: record.replyIntentId,
          sourceKind: record.sourceKind,
          deliveryType: record.deliveryPayload.type,
          providerMessageId: sendResult.providerMessageId,
          attempts: sendResult.attempts,
          dispatchMode: 'live',
          sideEffect: 'napcat_send',
          deliveryResult: 'sent',
          textPreview: previewText(record.text),
        },
        '投递成功',
      )
    }

    await replyRecordStore.markSent(record.id)
    return 'sent'
  } catch (error) {
    if (!sendSucceeded && record.providerMessageId == null && record.executionState !== 'acked') {
      await replyRecordStore.markFailed(record.id)
    }

    log.error(
      {
        error,
        groupId: record.groupId,
        scopeKey: record.scopeKey,
        replyIntentId: record.replyIntentId,
        deliveryType: record.deliveryPayload.type,
      },
      'reply record 投递失败',
    )
    throw error
  }
}
