import type { Message, UserMemory } from '../generated/prisma/client.js'
import type { GroupMemorySummaryResult, UserMemoryProfileResult } from '../llm/types.js'
import { getGroupMemory, getUserMemories } from '../database/memory.js'
import { createLogger } from '../logger.js'

const log = createLogger('MEMORY-LOADER')

const MAX_USER_PROFILES = 5

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function formatGroupMemory(summary: GroupMemorySummaryResult): string {
  const parts: string[] = []
  if (summary.summary) parts.push(`群氛围：${summary.summary}`)
  if (summary.topics.length > 0) parts.push(`近期话题：${summary.topics.join('、')}`)
  if (summary.styleTags.length > 0) parts.push(`风格标签：${summary.styleTags.join('、')}`)
  return parts.join('\n')
}

function formatUserMemory(mem: UserMemory): string {
  const name = mem.senderGroupNickname ?? mem.senderNickname ?? String(mem.senderId)
  const parsed = tryParseJson<UserMemoryProfileResult>(mem.profile)
  if (!parsed) return `- ${name}：（画像解析失败）`

  const parts: string[] = []
  if (parsed.profile) parts.push(parsed.profile)
  if (parsed.traits.length > 0) parts.push(`特征: ${parsed.traits.join('、')}`)
  return `- ${name}：${parts.join('；')}`
}

function rankSenderIds(recentMessages: Message[], senderBigInt: bigint): bigint[] {
  const counts = new Map<bigint, number>()
  for (const msg of recentMessages) {
    counts.set(msg.senderId, (counts.get(msg.senderId) ?? 0) + 1)
  }

  if (!counts.has(senderBigInt)) counts.set(senderBigInt, 0)

  return [...counts.entries()]
    .sort((a, b) => {
      if (a[0] === senderBigInt) return -1
      if (b[0] === senderBigInt) return 1
      return b[1] - a[1]
    })
    .slice(0, MAX_USER_PROFILES)
    .map(([id]) => id)
}

export async function buildMemorySnapshot(
  groupId: number,
  recentMessages: Message[],
  senderId: number,
): Promise<string | null> {
  const groupBigInt = BigInt(groupId)
  const senderBigInt = BigInt(senderId)

  const topSenderIds = rankSenderIds(recentMessages, senderBigInt)

  const [groupMem, userMems] = await Promise.all([
    getGroupMemory(groupBigInt),
    getUserMemories(groupBigInt, topSenderIds),
  ])

  const sections: string[] = []

  if (groupMem) {
    const parsed = tryParseJson<GroupMemorySummaryResult>(groupMem.summary)
    if (parsed) {
      const text = formatGroupMemory(parsed)
      if (text) sections.push(text)
    }
  }

  if (userMems.length > 0) {
    const sorted = [...userMems].sort((a, b) => {
      if (a.senderId === senderBigInt) return -1
      if (b.senderId === senderBigInt) return 1
      return 0
    })
    const lines = sorted.map(formatUserMemory)
    sections.push(`群成员印象：\n${lines.join('\n')}`)
  }

  if (sections.length === 0) return null

  const snapshot = `[记忆快照]\n${sections.join('\n\n')}`
  log.debug({ groupId, userCount: userMems.length, hasGroupMemory: !!groupMem }, 'memory_snapshot_built')
  return snapshot
}
