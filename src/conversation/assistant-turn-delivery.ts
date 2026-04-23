import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import {
  markAssistantTurnAcked,
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
  type AssistantTurnRecord,
} from './assistant-turn-store.js'
import { compactConversationIfNeeded } from './compaction.js'

const log = createLogger('ASSISTANT_TURN')

export interface AssistantTurnDeliveryDependencies {
  sender?: MessageSender
  assistantTurnStore?: {
    markAcked: typeof markAssistantTurnAcked
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  compactor?: typeof compactConversationIfNeeded
}

export type AssistantTurnDeliveryResult = 'sent' | 'failed' | 'skipped'

export async function deliverAssistantTurn(
  turn: AssistantTurnRecord,
  options: AssistantTurnDeliveryDependencies = {},
): Promise<AssistantTurnDeliveryResult> {
  if (turn.status === 'sent') return 'sent'

  const sender = options.sender ?? messageSender
  const assistantTurnStore = options.assistantTurnStore ?? {
    markAcked: markAssistantTurnAcked,
    markSending: markAssistantTurnSending,
    markSent: markAssistantTurnSent,
    markFailed: markAssistantTurnFailed,
  }
  const compactor = options.compactor ?? compactConversationIfNeeded

  if (sender.isReplyDryRunEnabled?.() ?? false) {
    log.info(
      {
        groupId: turn.groupId,
        senderThreadKey: turn.senderThreadKey,
        replyIntentId: turn.replyIntentId,
      },
      'assistant turn 投递跳过：reply dry run 已开启',
    )
    return 'skipped'
  }

  let sendSucceeded = false

  try {
    if (turn.providerMessageId == null && turn.status !== 'acked') {
      await assistantTurnStore.markSending(turn.id)

      const sendResult = await sender.replyToMessage({
        groupId: turn.groupId,
        replyToMessageId: turn.replyToMessageId,
        mentionUserId: turn.mentionUserId,
        text: turn.text,
      })

      if (!sendResult.success) {
        await assistantTurnStore.markFailed(turn.id)
        return 'failed'
      }

      if (sendResult.providerMessageId != null) {
        await assistantTurnStore.markAcked(turn.id, sendResult.providerMessageId)
      }

      sendSucceeded = true
    }
    await assistantTurnStore.markSent(turn.id)
    await compactor(turn.groupId, turn.senderThreadKey)
    return 'sent'
  } catch (error) {
    if (!sendSucceeded && turn.providerMessageId == null && turn.status !== 'acked') {
      await assistantTurnStore.markFailed(turn.id)
    }

    log.error(
      {
        error,
        groupId: turn.groupId,
        senderThreadKey: turn.senderThreadKey,
        replyIntentId: turn.replyIntentId,
      },
      'assistant turn 投递失败',
    )
    throw error
  }
}
