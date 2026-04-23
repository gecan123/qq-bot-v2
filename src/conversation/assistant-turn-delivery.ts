import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import {
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
  type AssistantTurnRecord,
} from './assistant-turn-store.js'
import { compactConversationIfNeeded } from './compaction.js'
import { updateConversationStateLastIncorporated } from './conversation-state-store.js'

const log = createLogger('ASSISTANT_TURN')

export interface AssistantTurnDeliveryDependencies {
  sender?: MessageSender
  assistantTurnStore?: {
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  conversationStateStore?: {
    updateLastIncorporated: typeof updateConversationStateLastIncorporated
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
    markSending: markAssistantTurnSending,
    markSent: markAssistantTurnSent,
    markFailed: markAssistantTurnFailed,
  }
  const conversationStateStore = options.conversationStateStore ?? {
    updateLastIncorporated: updateConversationStateLastIncorporated,
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

    sendSucceeded = true
    await assistantTurnStore.markSent(turn.id)
    await conversationStateStore.updateLastIncorporated(
      turn.groupId,
      turn.senderThreadKey,
      turn.incorporatedMessageRowId,
    )
    await compactor(turn.groupId, turn.senderThreadKey)
    return 'sent'
  } catch (error) {
    if (!sendSucceeded) {
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
