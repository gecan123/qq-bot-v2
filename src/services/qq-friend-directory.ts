import type { BotOwner } from '../config/index.js'
import type { QqGatewayFriend } from './qq-gateway-client.js'

export interface QqFriendDirectoryResult {
  friends: QqGatewayFriend[]
  status: 'live' | 'degraded'
  error?: unknown
}

export async function loadQqFriendsSafely(input: {
  loadFriends: () => Promise<readonly QqGatewayFriend[]>
  owner: BotOwner | null
  timeoutMs: number
}): Promise<QqFriendDirectoryResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('QQ friend directory timeoutMs must be a positive safe integer')
  }

  try {
    const friends = await withTimeout(input.loadFriends, input.timeoutMs)
    return {
      friends: includeOwner(friends, input.owner),
      status: 'live',
    }
  } catch (error) {
    return {
      friends: includeOwner([], input.owner),
      status: 'degraded',
      error,
    }
  }
}

async function withTimeout<T>(load: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(load),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`QQ friend directory timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function includeOwner(
  friends: readonly QqGatewayFriend[],
  owner: BotOwner | null,
): QqGatewayFriend[] {
  const result = friends.map((friend) => ({ ...friend }))
  if (owner && !result.some((friend) => friend.userId === owner.qq)) {
    result.push({ userId: owner.qq, nickname: owner.name })
  }
  return result
}
