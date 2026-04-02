import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { config } from '../config/index.js'
import {
  getGroupMemory,
  getGroupMemoryCursor,
  getUserMemory,
  saveGroupMemory,
  saveGroupMemoryCursor,
  upsertUserMemory,
} from '../database/memory.js'
import { formatMessagesForMemory } from '../memory/format-messages.js'
import { buildGroupSummaryPrompt, buildUserProfilePrompt } from '../memory/prompts.js'
import { chunkByTimeGap, addOverlap } from '../memory/chunk-messages.js'
import { buildRecoveryWindowWhere, resolveMemoryRefreshStart } from '../memory/message-cursor.js'
import { loadPrompt } from '../config/prompt-loader.js'
import type { Message } from '../generated/prisma/client.js'
import { getMessageTimestamp } from '../utils/message-time.js'

const MEMORY_SYSTEM_INSTRUCTION = loadPrompt('./prompts/memory-system.md')

const GAP_MINUTES = 20
const OVERLAP_SIZE = 15

function sortMessagesForMemory(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const timeDiff = getMessageTimestamp(a).getTime() - getMessageTimestamp(b).getTime()
    if (timeDiff !== 0) return timeDiff

    if (a.messageId !== b.messageId) {
      return a.messageId < b.messageId ? -1 : 1
    }

    return a.id - b.id
  })
}

function parseUserProfileJson(raw: string): { profile: string; examples: string[] } | null {
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).profile === 'string' &&
      Array.isArray((parsed as Record<string, unknown>).examples) &&
      ((parsed as Record<string, unknown>).examples as unknown[]).every((e) => typeof e === 'string')
    ) {
      return parsed as { profile: string; examples: string[] }
    }
  } catch {
    // fall through
  }
  return null
}

async function refreshGroup(groupId: number): Promise<void> {
  const provider = getLlmProvider()
  if (!provider?.generateText) {
    log.debug('LLM provider 不支持 generateText，跳过记忆更新')
    return
  }

  const groupBigInt = BigInt(groupId)
  const existing = await getGroupMemory(groupBigInt)
  const existingCursor = await getGroupMemoryCursor(groupBigInt)
  const refreshStart = resolveMemoryRefreshStart({
    lastProcessedMessageRowId: existingCursor?.lastProcessedMessageRowId ?? null,
  })
  const where =
    refreshStart.mode === 'cursor'
      ? { groupId: groupBigInt, id: { gt: refreshStart.lastProcessedMessageRowId } }
      : { groupId: groupBigInt, ...buildRecoveryWindowWhere(refreshStart.since) }

  const fetchedMessages = await prisma.message.findMany({ where, orderBy: { id: 'asc' } })
  const newMessages = sortMessagesForMemory(fetchedMessages)

  if (newMessages.length < config.memoryJobSkipThreshold) {
    log.info({ groupId, newCount: newMessages.length }, '新消息不足，跳过本群记忆更新')
    return
  }

  log.info({ groupId, newCount: newMessages.length }, '开始更新群记忆')

  const groupName = newMessages[newMessages.length - 1]?.groupName ?? null
  const lastMessage = newMessages[newMessages.length - 1] ?? null
  const maxMessageId = lastMessage?.messageId ?? existingCursor?.lastProcessedExternalMessageId ?? 0n
  const maxMessageDbId = lastMessage?.id ?? existingCursor?.lastProcessedMessageRowId ?? 0

  // Update group summary: chunk by time gap, add overlap, roll forward progressively
  const chunks = addOverlap(chunkByTimeGap(newMessages, GAP_MINUTES), OVERLAP_SIZE)
  let runningSummary = existing?.summary ?? null
  for (const chunk of chunks) {
    const formatted = formatMessagesForMemory(chunk)
    if (!formatted.trim()) continue
    const prompt = buildGroupSummaryPrompt(runningSummary, formatted)
    runningSummary = await provider.generateText(MEMORY_SYSTEM_INSTRUCTION, prompt)
    log.debug({ groupId, chunkSize: chunk.length }, '已处理一个消息分段')
  }

  if (runningSummary) {
    await saveGroupMemory({
      groupId: groupBigInt,
      groupName,
      summary: runningSummary,
    })
    await saveGroupMemoryCursor({
      groupId: groupBigInt,
      lastProcessedExternalMessageId: maxMessageId,
      lastProcessedMessageRowId: maxMessageDbId,
    })
    log.info({ groupId, chunks: chunks.length }, '群摘要已更新')
  }

  // Update per-user profiles (volume per user is small, no chunking needed)
  const byUser = new Map<bigint, Message[]>()
  for (const msg of newMessages) {
    const arr = byUser.get(msg.senderId) ?? []
    arr.push(msg)
    byUser.set(msg.senderId, arr)
  }

  for (const [senderId, userMsgs] of byUser) {
    const formattedUser = formatMessagesForMemory(userMsgs)
    if (!formattedUser.trim()) continue

    const existingUser = await getUserMemory(groupBigInt, senderId)
    const userPrompt = buildUserProfilePrompt(
      existingUser?.profile ?? null,
      existingUser?.examples ?? [],
      formattedUser,
    )
    const raw = await provider.generateText(MEMORY_SYSTEM_INSTRUCTION, userPrompt)
    const parsed = parseUserProfileJson(raw)

    if (!parsed) {
      log.warn({ groupId, senderId: senderId.toString() }, 'LLM 返回的用户画像 JSON 解析失败，跳过')
      continue
    }

    const lastMsg = userMsgs[userMsgs.length - 1]
    await upsertUserMemory({
      groupId: groupBigInt,
      groupName,
      senderId,
      senderNickname: lastMsg.senderNickname,
      senderGroupNickname: lastMsg.senderGroupNickname,
      profile: parsed.profile,
      examples: parsed.examples,
    })
    log.info({ groupId, senderId: senderId.toString() }, '用户画像已更新')
  }
}

async function runMemoryRefresh(): Promise<void> {
  log.info('开始记忆刷新 job')
  for (const groupId of config.groupIds) {
    try {
      await refreshGroup(groupId)
    } catch (err) {
      log.error({ err, groupId }, '群记忆更新失败')
    }
  }
  log.info('记忆刷新 job 完成')
}

export function startMemoryRefreshJob(): () => void {
  const intervalMs = config.memoryJobIntervalHours * 60 * 60 * 1000

  // Run once 30s after startup, then on fixed interval
  const startupTimer = setTimeout(() => {
    runMemoryRefresh().catch((err) => log.error({ err }, '初始记忆刷新失败'))
  }, 30_000)

  const intervalHandle = setInterval(() => {
    runMemoryRefresh().catch((err) => log.error({ err }, '定时记忆刷新失败'))
  }, intervalMs)

  return () => {
    clearTimeout(startupTimer)
    clearInterval(intervalHandle)
  }
}
