import type { ConversationRef } from '../chat/conversation.js'
import type { DeliveryRequest } from '../messaging/message-delivery.js'

export async function authorizeFeishuDelivery(input: {
  request: DeliveryRequest
  appId: string
  groupIds: readonly string[]
  isObservedConversation(conversation: ConversationRef): Promise<boolean>
  isMessageInConversation(conversation: ConversationRef, messageExternalId: string): Promise<boolean>
}): Promise<string | null> {
  const { request } = input
  if (request.target.platform !== 'feishu' || request.target.accountId !== input.appId) {
    return 'platform or account does not match this gateway'
  }
  if (request.target.kind === 'group') {
    if (!input.groupIds.includes(request.target.externalId)) return 'group is not configured'
  } else if (!await input.isObservedConversation(request.target)) {
    return 'private conversation was not observed'
  }
  if (
    request.replyToExternalId
    && !await input.isMessageInConversation(request.target, request.replyToExternalId)
  ) {
    return 'reply message does not belong to the target conversation'
  }
  return null
}
