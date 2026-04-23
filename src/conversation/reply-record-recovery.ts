import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  listRecoverableReplyRecords,
  markReplyRecordAcked,
  markReplyRecordFailed,
  markReplyRecordSending,
  markReplyRecordSent,
  type ReplyRecord,
} from './reply-record-store.js'
import { deliverReplyRecord } from './reply-record-delivery.js'
import { createReplyAudit } from './reply-audit-store.js'

const log = createLogger('REPLY_RECOVERY')

export interface ReplyRecordRecoveryResult {
  recoveredReplyRecords: number
  failedReplyRecords: number
}

export interface RecoverReplyRecordStartupOptions {
  groupIds: number[]
  sender?: MessageSender
  replyRecordStore?: {
    listRecoverable: typeof listRecoverableReplyRecords
    markAcked: typeof markReplyRecordAcked
    markSending: typeof markReplyRecordSending
    markSent: typeof markReplyRecordSent
    markFailed: typeof markReplyRecordFailed
  }
  replyAuditStore?: {
    create: typeof createReplyAudit
  }
  onReplyRecordRecovered?: (record: ReplyRecord) => Promise<void> | void
}

export async function recoverReplyRecordStartupState(
  options: RecoverReplyRecordStartupOptions,
): Promise<ReplyRecordRecoveryResult> {
  const replyRecordStore = options.replyRecordStore ?? {
    listRecoverable: (groupIds?: number[]) => listRecoverableReplyRecords(groupIds),
    markAcked: markReplyRecordAcked,
    markSending: markReplyRecordSending,
    markSent: markReplyRecordSent,
    markFailed: markReplyRecordFailed,
  }
  const replyAuditStore = options.replyAuditStore ?? {
    create: createReplyAudit,
  }

  let recoveredReplyRecords = 0
  let failedReplyRecords = 0

  const recoverableRecords = await replyRecordStore.listRecoverable(options.groupIds)
  for (const record of recoverableRecords) {
    const deliveryResult = await deliverReplyRecord(record, {
      sender: options.sender,
      replyRecordStore,
      replyAuditStore,
    })

    if (deliveryResult === 'sent') {
      recoveredReplyRecords++
      await options.onReplyRecordRecovered?.(record)
    } else if (deliveryResult === 'failed') {
      failedReplyRecords++
    }
  }

  log.info(
    {
      recoveredReplyRecords,
      failedReplyRecords,
    },
    'reply record 启动恢复完成',
  )

  return {
    recoveredReplyRecords,
    failedReplyRecords,
  }
}
