export function toSenderReplyScopeKey(senderId: number): string {
  return `sender:${senderId}`
}

export function toSceneSenderReplyScopeKey(sceneId: string, senderId: number): string {
  return `${sceneId}:sender:${senderId}`
}

export function toGroupReplyScopeKey(groupId: number): string {
  return `group:${groupId}`
}

export function parseSenderReplyScopeKey(scopeKey: string): number | null {
  const match = /^sender:(\d+)$/.exec(scopeKey)
  if (!match) return null

  const senderId = Number(match[1])
  return Number.isSafeInteger(senderId) ? senderId : null
}

export function parseGroupReplyScopeKey(scopeKey: string): number | null {
  const match = /^group:(\d+)$/.exec(scopeKey)
  if (!match) return null

  const groupId = Number(match[1])
  return Number.isSafeInteger(groupId) ? groupId : null
}
