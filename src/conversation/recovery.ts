import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  listRecoverableActionRecords,
  markActionRecordDeliveryState,
} from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId, type ActionRecord } from '../runtime/agent-runtime-types.js'

const log = createLogger('CONV_RECOVERY')

export interface ConversationRecoveryResult {
  recoveredActionRecords: number
  failedActionRecords: number
  enqueuedMentions: number
}

export interface RecoverConversationStartupOptions {
  groupIds: number[]
  sender?: MessageSender
  actionRecordStore?: {
    listRecoverable: typeof listRecoverableActionRecords
    markDeliveryState: typeof markActionRecordDeliveryState
  }
  onActionRecordRecovered?: (actionRecord: ActionRecord) => Promise<void> | void
}

export async function recoverConversationStartupState(
  options: RecoverConversationStartupOptions,
): Promise<ConversationRecoveryResult> {
  const actionRecordStore = options.actionRecordStore ?? {
    listRecoverable: listRecoverableActionRecords,
    markDeliveryState: markActionRecordDeliveryState,
  }
  const sceneIds = options.groupIds.map((id) => makeQqGroupSceneId(id))
  const recoverable = await actionRecordStore.listRecoverable(sceneIds)
  let recoveredActionRecords = 0
  let failedActionRecords = 0

  for (const actionRecord of recoverable) {
    if (actionRecord.deliveryState === 'acked') {
      await actionRecordStore.markDeliveryState(actionRecord.id, 'sent')
      recoveredActionRecords++
      await options.onActionRecordRecovered?.(actionRecord)
      continue
    }

    if (
      actionRecord.deliveryState === 'pending' ||
      actionRecord.deliveryState === 'sending' ||
      actionRecord.deliveryState === 'failed'
    ) {
      if (!options.sender) {
        await actionRecordStore.markDeliveryState(actionRecord.id, 'failed')
        failedActionRecords++
        continue
      }
      await actionRecordStore.markDeliveryState(actionRecord.id, 'pending')
      recoveredActionRecords++
      await options.onActionRecordRecovered?.(actionRecord)
    }
  }

  log.info(
    {
      recoveredActionRecords,
      failedActionRecords,
    },
    '动作启动恢复完成',
  )

  return {
    recoveredActionRecords,
    failedActionRecords,
    enqueuedMentions: 0,
  }
}
