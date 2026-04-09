import { getAgentProfile } from '../../config/agent-profiles.js'
import { loadPrompt } from '../../config/prompt-loader.js'
import { getRecentGroupMessages } from '../../database/messages.js'
import { resolveMessage } from '../../media/message-resolver.js'
import { segmentsToPlainText } from '../../utils/segment-text.js'
import { getMessageTimestamp } from '../../utils/message-time.js'
import { buildMemorySnapshot } from '../memory-loader.js'
import { runAgentSession } from '../agent-session.js'
import { messageSender, type MessageSender } from '../../messaging/message-sender.js'
import { createLogger } from '../../logger.js'
import type { AgentMessage } from '../../agent/types.js'
import type { Message } from '../../generated/prisma/client.js'
import { judgeProactive } from './judge.js'

const PROACTIVE_INSTRUCTION = loadPrompt('./prompts/proactive-instruction.md')
const log = createLogger('PROACTIVE')

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

async function buildRecentMessagesText(groupId: number, limit: number): Promise<{ text: string; recentMessages: Message[] }> {
  const recentMessages = await getRecentGroupMessages(groupId, limit)
  const resolvedMessages = await Promise.all(
    recentMessages.map((dbMsg) => resolveMessage(dbMsg, { timeoutMs: 0 })),
  )

  const lines: string[] = []
  for (const [index, dbMsg] of recentMessages.entries()) {
    const resolvedSegments = resolvedMessages[index] ?? []
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname
    const time = formatTime(getMessageTimestamp(dbMsg))
    const text = segmentsToPlainText(resolvedSegments)
    if (text) lines.push(`[${time}] ${nickname}: ${text}`)
  }

  return { text: lines.join('\n'), recentMessages }
}

export interface ProactiveEvaluateOptions {
  sender?: MessageSender
  lastBotReplyAt?: number
  cooldownMs?: number
}

export async function evaluateAndReply(groupId: number, options: ProactiveEvaluateOptions = {}): Promise<boolean> {
  const sender = options.sender ?? messageSender
  const cooldownMs = options.cooldownMs ?? 120_000

  if (options.lastBotReplyAt && Date.now() - options.lastBotReplyAt < cooldownMs) {
    log.debug({ groupId }, 'proactive 处于 cooldown，跳过')
    return false
  }

  const profile = getAgentProfile(groupId)
  if (!profile.proactivePolicy?.enabled) {
    return false
  }

  const contextLimit = profile.replyContextMessages ?? 20
  const { text: recentText, recentMessages } = await buildRecentMessagesText(groupId, contextLimit)

  if (!recentText.trim()) {
    return false
  }

  const judgeResult = await judgeProactive(recentText, profile.persona)
  if (!judgeResult.shouldReply) {
    return false
  }

  log.info({ groupId, topic: judgeResult.topic }, '主动回复 judge 通过，开始生成')

  const memorySnapshot = await buildMemorySnapshot(groupId, recentMessages, 0)

  const contextContent = `[群聊背景]\n${recentText}`
  const triggerContent = judgeResult.topic
    ? `你注意到群里在聊关于「${judgeResult.topic}」的话题，自然地加入对话。`
    : '你注意到群里的对话，觉得有话可说，自然地加入对话。'

  const initialHistory: AgentMessage[] = []
  if (memorySnapshot) {
    initialHistory.push(
      { role: 'user', content: memorySnapshot },
      { role: 'model', content: '了解。' },
    )
  }
  initialHistory.push(
    { role: 'user', content: contextContent },
    { role: 'model', content: '好的。' },
    { role: 'user', content: triggerContent },
  )

  const result = await runAgentSession({
    groupId,
    persona: profile.persona,
    instruction: PROACTIVE_INSTRUCTION,
    initialHistory,
    maxSteps: profile.agentMaxSteps,
    warningTimeMs: profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
    maxAnswerChars: profile.agentMaxAnswerChars,
  })

  log.info(
    { groupId, state: result.state, reason: 'reason' in result ? result.reason : undefined },
    'proactive_agent_result',
  )

  if (result.state !== 'final') {
    return false
  }

  if (profile.proactivePolicy?.dryRun) {
    log.info({ groupId, text: result.answer }, '[DRY RUN] 主动回复（未发送）')
    return false
  }

  await sender.sendMessage({ groupId, text: result.answer })
  log.info({ groupId }, '主动回复已发送')
  return true
}
