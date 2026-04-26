import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  listRecoverableActionRecords,
  markActionRecordDeliveryState,
} from '../runtime/agent-runtime-store.js'
import { getActionRecordText } from '../runtime/action-record-payload.js'
import { makeQqGroupSceneId, type ActionRecord } from '../runtime/agent-runtime-types.js'

const log = createLogger('CONV_RECOVERY')

export interface ConversationRecoveryResult {
  recoveredActionRecords: number
  failedActionRecords: number
  enqueuedMentions: number
}

export interface RecoverConversationStartupOptions {
  groupIds: number[]
  includePrivateScenes?: boolean
  sender?: MessageSender
  actionRecordStore?: {
    listRecoverable: typeof listRecoverableActionRecords
    markDeliveryState: typeof markActionRecordDeliveryState
  }
  onActionRecordRecovered?: (actionRecord: ActionRecord) => Promise<void> | void
}

function getNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function getDeliveryPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const deliveryPayload = payload.deliveryPayload
  return deliveryPayload && typeof deliveryPayload === 'object' && !Array.isArray(deliveryPayload)
    ? deliveryPayload as Record<string, unknown>
    : null
}

function getRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getGroupId(
  resultPayload: Record<string, unknown>,
  deliveryPayload: Record<string, unknown>,
): number | null {
  return getNumber(getRecord(resultPayload, 'target') ?? {}, 'groupId') ?? getNumber(deliveryPayload, 'groupId')
}

function getUserId(
  resultPayload: Record<string, unknown>,
  deliveryPayload: Record<string, unknown>,
): number | null {
  return getNumber(getRecord(resultPayload, 'target') ?? {}, 'userId') ?? getNumber(deliveryPayload, 'userId')
}

function isPrivateSceneId(sceneId: string): boolean {
  return sceneId.startsWith('qq_private:')
}

async function recoverSendableActionRecord(input: {
  actionRecord: ActionRecord
  sender: MessageSender
  markDeliveryState: typeof markActionRecordDeliveryState
}): Promise<boolean> {
  const resultPayload = input.actionRecord.resultPayload ?? {}
  const deliveryPayload = getDeliveryPayload(resultPayload)
  const text = getActionRecordText(input.actionRecord)
  if (!deliveryPayload || !text) {
    await input.markDeliveryState(input.actionRecord.id, 'failed', {
      ...resultPayload,
      recoveryError: 'invalid action result payload',
    })
    return false
  }

  await input.markDeliveryState(input.actionRecord.id, 'sending', resultPayload)
  const deliveryType = deliveryPayload.type
  if (deliveryType !== 'reply_to_message' && deliveryType !== 'send_message' && deliveryType !== 'send_private_message') {
    await input.markDeliveryState(input.actionRecord.id, 'failed', {
      ...resultPayload,
      recoveryError: 'unsupported delivery type',
    })
    return false
  }

  if (deliveryType === 'send_private_message') {
    const userId = getUserId(resultPayload, deliveryPayload)
    if (userId == null || !input.sender.sendPrivateMessage) {
      await input.markDeliveryState(input.actionRecord.id, 'failed', {
        ...resultPayload,
        recoveryError: userId == null ? 'missing private target' : 'missing private sender',
      })
      return false
    }

    const sendResult = await input.sender.sendPrivateMessage({ userId, text })
    if (!sendResult.success) {
      await input.markDeliveryState(input.actionRecord.id, 'failed', {
        ...resultPayload,
        recoveryError: 'send failed',
      })
      return false
    }

    await input.markDeliveryState(input.actionRecord.id, 'sent', {
      ...resultPayload,
      providerMessageId: sendResult.providerMessageId ?? null,
      attempts: sendResult.attempts,
      recoveredAt: new Date().toISOString(),
    })
    return true
  }

  const groupId = getGroupId(resultPayload, deliveryPayload)
  if (groupId == null) {
    await input.markDeliveryState(input.actionRecord.id, 'failed', {
      ...resultPayload,
      recoveryError: 'missing group target',
    })
    return false
  }

  const replyToMessageId = getNumber(deliveryPayload, 'replyToMessageId') ?? getNumber(deliveryPayload, 'messageId')
  if (deliveryType === 'reply_to_message' && replyToMessageId == null) {
    await input.markDeliveryState(input.actionRecord.id, 'failed', {
      ...resultPayload,
      recoveryError: 'missing reply target',
    })
    return false
  }

  const sendResult = deliveryType === 'reply_to_message'
    ? await input.sender.replyToMessage({
        groupId,
        replyToMessageId: replyToMessageId ?? 0,
        mentionUserId: getNumber(deliveryPayload, 'mentionUserId') ?? undefined,
        text,
      })
    : await input.sender.sendMessage({ groupId, text })

  if (!sendResult.success) {
    await input.markDeliveryState(input.actionRecord.id, 'failed', {
      ...resultPayload,
      recoveryError: 'send failed',
    })
    return false
  }

  await input.markDeliveryState(input.actionRecord.id, 'sent', {
    ...resultPayload,
    providerMessageId: sendResult.providerMessageId ?? null,
    attempts: sendResult.attempts,
    recoveredAt: new Date().toISOString(),
  })
  return true
}

export async function recoverConversationStartupState(
  options: RecoverConversationStartupOptions,
): Promise<ConversationRecoveryResult> {
  const actionRecordStore = options.actionRecordStore ?? {
    listRecoverable: listRecoverableActionRecords,
    markDeliveryState: markActionRecordDeliveryState,
  }
  const sceneIds = options.groupIds.map((id) => makeQqGroupSceneId(id))
  const groupSceneIds = new Set<string>(sceneIds)
  const recoverable = await actionRecordStore.listRecoverable(options.includePrivateScenes ? undefined : sceneIds)
  const scopedRecoverable = recoverable.filter((actionRecord) =>
    groupSceneIds.has(actionRecord.targetSceneId) ||
    (options.includePrivateScenes === true && isPrivateSceneId(actionRecord.targetSceneId))
  )
  let recoveredActionRecords = 0
  let failedActionRecords = 0

  for (const actionRecord of scopedRecoverable) {
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
      const recovered = await recoverSendableActionRecord({
        actionRecord,
        sender: options.sender,
        markDeliveryState: actionRecordStore.markDeliveryState,
      })
      if (recovered) {
        recoveredActionRecords++
        await options.onActionRecordRecovered?.(actionRecord)
      } else {
        failedActionRecords++
      }
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
