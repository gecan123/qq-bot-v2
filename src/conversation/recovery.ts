import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import {
  listRecoverableAssistantTurns,
  markAssistantTurnAcked,
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
} from './assistant-turn-store.js'
import { deliverAssistantTurn } from './assistant-turn-delivery.js'
import { compactConversationIfNeeded } from './compaction.js'

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
    markAcked: typeof markAssistantTurnAcked
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  compactor?: typeof compactConversationIfNeeded
  onAssistantTurnRecovered?: (turn: Awaited<ReturnType<typeof listRecoverableAssistantTurns>>[number]) => Promise<void> | void
}

export async function recoverConversationStartupState(
  options: RecoverConversationStartupOptions,
): Promise<ConversationRecoveryResult> {
  const assistantTurnStore = options.assistantTurnStore ?? {
    listRecoverable: (groupIds?: number[]) => listRecoverableAssistantTurns(groupIds),
    markAcked: markAssistantTurnAcked,
    markSending: markAssistantTurnSending,
    markSent: markAssistantTurnSent,
    markFailed: markAssistantTurnFailed,
  }
  const compactor = options.compactor ?? compactConversationIfNeeded

  let recoveredAssistantTurns = 0
  let failedAssistantTurns = 0

  const recoverableTurns = await assistantTurnStore.listRecoverable(options.groupIds)
  for (const turn of recoverableTurns) {
    const deliveryResult = await deliverAssistantTurn(turn, {
      sender: options.sender,
      assistantTurnStore,
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
