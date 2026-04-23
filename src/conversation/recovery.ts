import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  listRecoverableAssistantTurns,
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
} from './assistant-turn-store.js'
import { deliverAssistantTurn } from './assistant-turn-delivery.js'
import { compactConversationIfNeeded } from './compaction.js'
import { updateConversationStateLastIncorporated } from './conversation-state-store.js'

const log = createLogger('CONV_RECOVERY')

export interface ConversationRecoveryResult {
  recoveredAssistantTurns: number
  failedAssistantTurns: number
  enqueuedMentions: number
}

export interface RecoverConversationStartupOptions {
  groupIds: number[]
  sender?: MessageSender
  assistantTurnStore?: {
    listRecoverable: typeof listRecoverableAssistantTurns
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  conversationStateStore?: {
    updateLastIncorporated: typeof updateConversationStateLastIncorporated
  }
  compactor?: typeof compactConversationIfNeeded
  onAssistantTurnRecovered?: (turn: Awaited<ReturnType<typeof listRecoverableAssistantTurns>>[number]) => Promise<void> | void
}

export async function recoverConversationStartupState(
  options: RecoverConversationStartupOptions,
): Promise<ConversationRecoveryResult> {
  const assistantTurnStore = options.assistantTurnStore ?? {
    listRecoverable: (groupIds?: number[]) => listRecoverableAssistantTurns(groupIds),
    markSending: markAssistantTurnSending,
    markSent: markAssistantTurnSent,
    markFailed: markAssistantTurnFailed,
  }
  const conversationStateStore = options.conversationStateStore ?? {
    updateLastIncorporated: updateConversationStateLastIncorporated,
  }
  const compactor = options.compactor ?? compactConversationIfNeeded

  let recoveredAssistantTurns = 0
  let failedAssistantTurns = 0

  const recoverableTurns = await assistantTurnStore.listRecoverable(options.groupIds)
  for (const turn of recoverableTurns) {
    const deliveryResult = await deliverAssistantTurn(turn, {
      sender: options.sender,
      assistantTurnStore,
      conversationStateStore,
      compactor,
    })

    if (deliveryResult === 'sent') {
      recoveredAssistantTurns++
      await options.onAssistantTurnRecovered?.(turn)
    } else if (deliveryResult === 'failed') {
      failedAssistantTurns++
    }
  }

  log.info(
    {
      recoveredAssistantTurns,
      failedAssistantTurns,
    },
    '会话启动恢复完成',
  )

  return {
    recoveredAssistantTurns,
    failedAssistantTurns,
    enqueuedMentions: 0,
  }
}
