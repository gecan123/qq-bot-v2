import type { MessageSender } from '../messaging/message-sender.js'
import type { ActionIntent, ActionRecord, ActionDeliveryState } from './agent-runtime-types.js'
import { createOrReuseActionRecord } from './agent-runtime-store.js'

export interface ActionExecutorOptions {
  sender?: MessageSender
  actionStore?: {
    createOrReuseActionRecord: typeof createOrReuseActionRecord
    markDeliveryState?: (id: string, state: ActionDeliveryState, result?: Record<string, unknown>) => Promise<void>
  }
}

export interface ActionExecutorResult {
  intent: ActionIntent
  actionRecord: ActionRecord
  deliveryResult: ActionDeliveryState
}

const SEND_GROUP_MESSAGE_ACTION = 'send_group_message'

function getNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function getText(payload: Record<string, unknown>): string {
  const value = payload.text
  return typeof value === 'string' ? value : ''
}

export function createActionExecutor(options: ActionExecutorOptions = {}) {
  const store = options.actionStore ?? { createOrReuseActionRecord }

  return {
    async execute(intent: ActionIntent): Promise<ActionExecutorResult> {
      const payload = intent.payload as Record<string, unknown>
      const initialState: ActionDeliveryState = intent.dryRun || intent.actionType === 'artifact_only' ? 'dry_run' : 'pending'
      const actionRecord = await store.createOrReuseActionRecord({
        actionIntentId: intent.id,
        actionType: intent.actionType,
        targetSceneId: intent.targetSceneId,
        deliveryState: initialState,
        idempotencyKey: intent.idempotencyKey,
        resultPayload: initialState === 'dry_run' ? { reason: 'ambient_candidate dryRun artifact-only' } : null,
      })

      if (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked' || actionRecord.deliveryState === 'dry_run') {
        return { intent, actionRecord, deliveryResult: actionRecord.deliveryState }
      }

      if (!options.sender) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { reason: 'missing sender' })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      const groupId = getNumber(payload, 'groupId')
      const text = getText(payload)
      if (groupId == null || !text) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { reason: 'invalid payload' })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      await store.markDeliveryState?.(actionRecord.id, 'sending')
      const messageId =
        intent.actionType === 'reply_to_message'
          ? getNumber(payload, 'messageId')
          : null
      const sendResult = messageId != null
        ? await options.sender.replyToMessage({ groupId, replyToMessageId: messageId, text })
        : await options.sender.sendMessage({ groupId, text })

      if (!sendResult.success) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { error: 'send failed' })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      const deliveryResult: ActionDeliveryState = sendResult.providerMessageId == null ? 'sent' : 'acked'
      await store.markDeliveryState?.(actionRecord.id, deliveryResult, { providerMessageId: sendResult.providerMessageId ?? null })
      return { intent, actionRecord, deliveryResult }
    },
  }
}
