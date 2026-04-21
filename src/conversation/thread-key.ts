export function toSenderThreadKey(senderId: number): string {
  return `sender:${senderId}`
}

export function parseSenderThreadKey(senderThreadKey: string): number | null {
  const match = /^sender:(\d+)$/.exec(senderThreadKey)
  if (!match) return null

  const senderId = Number(match[1])
  return Number.isSafeInteger(senderId) ? senderId : null
}
