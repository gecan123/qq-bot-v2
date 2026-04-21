import { getGroupMessagesAfterRowId } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import type { ConversationQueue } from '../queue/conversation-queue.js'
import { getMessageTimestamp } from '../utils/message-time.js'
import {
  listRecoverableAssistantTurns,
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
} from './assistant-turn-store.js'
import { deliverAssistantTurn } from './assistant-turn-delivery.js'
import { compactConversationIfNeeded } from './compaction.js'
import {
  listConversationStatesByGroupIds,
  updateConversationStateLastIncorporated,
} from './conversation-state-store.js'
import { parseSenderThreadKey } from './thread-key.js'

const log = createLogger('CONV_RECOVERY')

export interface ConversationRecoveryResult {
  recoveredAssistantTurns: number
  failedAssistantTurns: number
  enqueuedMentions: number
}

export interface RecoverConversationStartupOptions {
  groupIds: number[]
  selfNumber: number
  queue: ConversationQueue
  sender?: MessageSender
  assistantTurnStore?: {
    listRecoverable: typeof listRecoverableAssistantTurns
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  conversationStateStore?: {
    listByGroupIds: typeof listConversationStatesByGroupIds
    updateLastIncorporated: typeof updateConversationStateLastIncorporated
  }
  messageStore?: {
    listAfterRowId: typeof getGroupMessagesAfterRowId
  }
  compactor?: typeof compactConversationIfNeeded
}

function messageMentionsSelf(message: Message, selfNumber: number): boolean {
  const segments = Array.isArray(message.content) ? message.content : []

  return segments.some((segment) => {
    if (!segment || typeof segment !== 'object') return false
    if (!('type' in segment) || segment.type !== 'at') return false
    if (!('targetId' in segment)) return false
    return String(segment.targetId) === String(selfNumber)
  })
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
    listByGroupIds: listConversationStatesByGroupIds,
    updateLastIncorporated: updateConversationStateLastIncorporated,
  }
  const messageStore = options.messageStore ?? {
    listAfterRowId: getGroupMessagesAfterRowId,
  }
  const compactor = options.compactor ?? compactConversationIfNeeded

  let recoveredAssistantTurns = 0
  let failedAssistantTurns = 0
  let enqueuedMentions = 0

  const recoverableTurns = await assistantTurnStore.listRecoverable(options.groupIds)
  for (const turn of recoverableTurns) {
    const delivered = await deliverAssistantTurn(turn, {
      sender: options.sender,
      assistantTurnStore,
      conversationStateStore,
      compactor,
    })

    if (delivered) {
      recoveredAssistantTurns++
    } else {
      failedAssistantTurns++
    }
  }

  const states = await conversationStateStore.listByGroupIds(options.groupIds)
  for (const state of states) {
    if (state.lastIncorporatedMessageRowId === undefined) continue

    const senderId = parseSenderThreadKey(state.senderThreadKey)
    if (senderId == null) {
      log.warn({ senderThreadKey: state.senderThreadKey }, '无法解析 senderThreadKey，跳过启动恢复')
      continue
    }

    const messages = await messageStore.listAfterRowId(state.groupId, state.lastIncorporatedMessageRowId)
    for (const message of messages) {
      if (Number(message.senderId) !== senderId) continue
      if (!messageMentionsSelf(message, options.selfNumber)) continue

      options.queue.enqueueMention({
        groupId: state.groupId,
        messageId: Number(message.messageId),
        senderId,
        createdAt: getMessageTimestamp(message).getTime(),
      })
      enqueuedMentions++
    }
  }

  log.info(
    {
      recoveredAssistantTurns,
      failedAssistantTurns,
      enqueuedMentions,
    },
    '会话启动恢复完成',
  )

  return {
    recoveredAssistantTurns,
    failedAssistantTurns,
    enqueuedMentions,
  }
}
