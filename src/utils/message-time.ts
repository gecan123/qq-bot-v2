export interface MessageTimestampLike {
  sentAt: Date | null
  createdAt: Date
}

export function getMessageTimestamp(message: MessageTimestampLike): Date {
  return message.sentAt ?? message.createdAt
}
