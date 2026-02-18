import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { config } from '../config/index.js'
import { getGroupMemory, upsertGroupMemory, getUserMemory, upsertUserMemory } from '../database/memory.js'
import { formatMessagesForMemory } from '../memory/format-messages.js'
import { buildGroupSummaryPrompt, buildUserProfilePrompt } from '../memory/prompts.js'
import { chunkByTimeGap, addOverlap } from '../memory/chunk-messages.js'
import type { Message } from '../generated/prisma/client.js'

const MEMORY_SYSTEM_INSTRUCTION =
  '你是一个群聊分析助手，负责为机器人维护对群聊和群成员的长期印象记忆。请根据提供的消息客观、简洁地更新印象描述。'

const GAP_MINUTES = 20
const OVERLAP_SIZE = 15

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
  const lastMessageId = existing?.lastMessageId ?? 0n

  const newMessages = await prisma.message.findMany({
    where: { groupId: groupBigInt, messageId: { gt: lastMessageId } },
    orderBy: { messageId: 'asc' },
  })

  if (newMessages.length < config.memoryJobSkipThreshold) {
    log.debug({ groupId, newCount: newMessages.length }, '新消息不足，跳过本群记忆更新')
    return
  }

  log.info({ groupId, newCount: newMessages.length }, '开始更新群记忆')

  const groupName = newMessages[newMessages.length - 1]?.groupName ?? null
  const maxMessageId = newMessages.reduce((max, m) => (m.messageId > max ? m.messageId : max), 0n)

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
    await upsertGroupMemory({ groupId: groupBigInt, groupName, summary: runningSummary, lastMessageId: maxMessageId })
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
