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
import { checkGate } from './gate.js'
import { computeOpportunityScore, detectUnansweredQuestion } from './scorer.js'
import type { GateContext } from './types.js'

const PROACTIVE_INSTRUCTION = loadPrompt('./prompts/proactive-instruction.md')
const log = createLogger('PROACTIVE')

const MOOD_HINTS = [
  '今天你有点懒得展开，能简短就简短。',
  '今天你比较有话说，想多说一句也行。',
  '今天你有点嘴碎，但不是没话找话。',
  '今天你比较直接，想到什么说什么。',
  '今天你比较冷静，不太想热场。',
  '今天你有点活跃，容易被话题带起来。',
  '今天你有点懒，只想说最关键的那句。',
  '今天你比较随性，跑题也没关系。',
] as const

// 每个群最近 5 条主动回复，用于反模式注入
const recentRepliesCache = new Map<number, string[]>()

function getRecentReplies(groupId: number): string[] {
  return recentRepliesCache.get(groupId) ?? []
}

function recordReply(groupId: number, text: string): void {
  const existing = recentRepliesCache.get(groupId) ?? []
  recentRepliesCache.set(groupId, [...existing, text].slice(-5))
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function buildTriggerContent(lines: readonly string[]): string {
  return lines.slice(-3).join('\n')
}

async function buildRecentMessagesText(groupId: number, limit: number): Promise<{ text: string; lines: string[]; recentMessages: Message[] }> {
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

  return { text: lines.join('\n'), lines, recentMessages }
}

export interface ProactiveEvaluateOptions {
  sender?: MessageSender
  lastBotReplyAt?: number
  cooldownMs?: number
  recentProactiveTimestamps?: readonly number[]
  messagesSinceLastEval?: number
  onProactiveAttempt?: () => void
}

export async function evaluateAndReply(groupId: number, options: ProactiveEvaluateOptions = {}): Promise<boolean> {
  const sender = options.sender ?? messageSender
  const profile = getAgentProfile(groupId)

  if (!profile.proactivePolicy?.enabled) {
    return false
  }

  const policy = profile.proactivePolicy

  // --- Layer 1: Hard Rule Gate ---
  const gateCtx: GateContext = {
    lastBotReplyAt: options.lastBotReplyAt,
    cooldownMs: options.cooldownMs ?? policy.cooldownMs ?? 120_000,
    recentProactiveTimestamps: options.recentProactiveTimestamps ?? [],
    hourlyBudget: policy.hourlyBudget ?? 3,
    messagesSinceLastEval: options.messagesSinceLastEval ?? 0,
    minMessages: policy.minMessages ?? 5,
  }

  const gateResult = checkGate(gateCtx)
  if (!gateResult.passed) {
    return false
  }

  // --- Layer 2: Opportunity Scorer ---
  const contextLimit = profile.replyContextMessages ?? 20
  const { text: recentText, lines, recentMessages } = await buildRecentMessagesText(groupId, contextLimit)

  if (!recentText.trim()) {
    return false
  }

  const lastMessage = recentMessages[recentMessages.length - 1]
  const silenceSeconds = lastMessage
    ? (Date.now() - getMessageTimestamp(lastMessage).getTime()) / 1000
    : 0

  const uniqueSenderIds = new Set(recentMessages.map((m) => Number(m.senderId)))

  const scoreResult = computeOpportunityScore(
    {
      messageCount: options.messagesSinceLastEval ?? recentMessages.length,
      uniqueSenderCount: uniqueSenderIds.size,
      silenceSeconds,
      hasUnansweredQuestion: detectUnansweredQuestion(lines),
    },
    policy.scoreThreshold ?? 45,
  )

  if (!scoreResult.shouldProceed) {
    return false
  }

  // --- Layer 3: Candidate Generation ---
  log.info({ groupId, score: scoreResult.score }, '机会评分通过，开始生成')

  const memorySnapshot = await buildMemorySnapshot(groupId, recentMessages, 0)

  const contextContent = `[群聊背景]\n${recentText}`
  const triggerContent = buildTriggerContent(lines)

  if (!triggerContent) {
    return false
  }

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

  // Layer 2: 随机状态注入
  const moodHint = MOOD_HINTS[Math.floor(Math.random() * MOOD_HINTS.length)]!

  // Layer 3: 近期回复反模式注入
  const recentReplies = getRecentReplies(groupId)
  const recentRepliesNote =
    recentReplies.length > 0
      ? `\n\n[你最近在这个群的发言（句式和切入角度不要雷同）]\n${recentReplies.map((r) => `- ${r}`).join('\n')}`
      : ''

  const instruction = `${PROACTIVE_INSTRUCTION}\n\n[今日状态]\n${moodHint}${recentRepliesNote}`

  const result = await runAgentSession({
    groupId,
    persona: profile.persona,
    instruction,
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

  // dryRun 也计数，保证预算消耗真实
  options.onProactiveAttempt?.()

  // Layer 3: 记录本次回复，供下次反模式注入
  recordReply(groupId, result.answer)

  if (policy.dryRun) {
    log.info({ groupId, text: result.answer }, '[DRY RUN] 主动回复（未发送）')
    return false
  }

  await sender.sendMessage({ groupId, text: result.answer })
  log.info({ groupId }, '主动回复已发送')
  return true
}
