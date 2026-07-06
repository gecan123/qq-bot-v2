export type SendTarget =
  | { type: 'group'; groupId: number; mentionUserId?: number }
  | { type: 'private'; userId: number }

export type SendMode = 'ambient' | 'reply'

export type SendAuthorization =
  | { allowed: true }
  | { allowed: false; error: string }

export interface SendTargetPolicy {
  authorize(input: { target: SendTarget; mode: SendMode }): Promise<SendAuthorization>
}

export interface SendTargetPolicyDeps {
  groupIds: readonly number[]
  groupAmbientSendIds: ReadonlySet<number>
  loadFriendIds: () => Promise<readonly number[]>
}

export function createSendTargetPolicy(deps: SendTargetPolicyDeps): SendTargetPolicy {
  const monitoredGroups = new Set(deps.groupIds)

  return {
    async authorize(input) {
      if (input.target.type === 'group') {
        if (!monitoredGroups.has(input.target.groupId)) {
          return { allowed: false, error: `groupId=${input.target.groupId} is not monitored` }
        }
        if (input.mode === 'ambient' && !deps.groupAmbientSendIds.has(input.target.groupId)) {
          return {
            allowed: false,
            error: `groupId=${input.target.groupId} does not allow ambient sends`,
          }
        }
        return { allowed: true }
      }

      try {
        const friendIds = await deps.loadFriendIds()
        if (friendIds.includes(input.target.userId)) return { allowed: true }
        return {
          allowed: false,
          error: `userId=${input.target.userId} is not a current QQ friend`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { allowed: false, error: `QQ friend list unavailable: ${message}` }
      }
    },
  }
}
