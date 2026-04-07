import OpenAI from 'openai'
import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createAgentOpenAIConfig, createOpenAIChatFn } from '../agent/openai-compat.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { getCurrentTokenUsageTracker, runWithTokenUsageTracking } from '../llm/token-usage.js'
import { log } from '../logger.js'
import type { AgentMessage } from '../agent/types.js'
import type { IncomingMessage } from './pipeline.js'
import { buildContext, extractResolvedTriggerText } from './context-builder.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'

const REPLY_INSTRUCTION = loadPrompt('./prompts/reply-instruction.md')

const _agentConfig = createAgentOpenAIConfig()
const _agentClient = new OpenAI({ baseURL: _agentConfig.baseURL, apiKey: _agentConfig.apiKey })
const _agentModel = _agentConfig.model

async function agentReply(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
): Promise<string | null> {
  const context = await buildContext(msg, contextLimit)
  const triggerText = await extractResolvedTriggerText(msg.groupId, msg.messageId, msg.segments)

  const contextContent = context
    ? `[群聊背景]\n${context}`
    : '[群聊背景]\n（暂无近期消息记录）'
  const triggerContent = triggerText
    ? `请根据你的人设回复这条消息：${triggerText}`
    : '（用户@了你，请根据你的人设回复）'

  const initialHistory: AgentMessage[] = [
    { role: 'user', content: contextContent },
    { role: 'model', content: '好的。' },
    { role: 'user', content: triggerContent },
  ]

  const { declarations, executors } = createAgentTools(msg.groupId)
  const chatFn = createOpenAIChatFn(_agentClient, _agentModel, { reasoningEffort: 'medium' })
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const systemPrompt = [
    `当前时间：${now}`,
    '',
    '[群聊人格基座]',
    persona,
    '',
    '[任务约束]',
    REPLY_INSTRUCTION,
  ].join('\n')

  const result = await runAgentLoop({
    systemPrompt,
    initialHistory,
    chatFn,
    tools: declarations,
    executors,
    maxSteps,
    warningTimeMs,
    maxAnswerChars,
  })

  log.info(
    { groupId: msg.groupId, state: result.state, reason: 'reason' in result ? result.reason : undefined },
    'at_mention_agent_result',
  )

  if (result.state === 'final') return result.answer
  return null
}

export async function generateMentionReply(msg: IncomingMessage): Promise<string | null> {
  return runWithTokenUsageTracking(async () => {
    const startedAt = Date.now()
    const mode: 'agent' = 'agent'

    try {
      const profile = getAgentProfile(msg.groupId)
      const contextLimit = profile.replyContextMessages ?? 20

      const reply = await agentReply(
        msg,
        profile.persona,
        contextLimit,
        profile.agentMaxSteps,
        profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
        profile.agentMaxAnswerChars,
      )
      return reply
    } finally {
      const summary = getCurrentTokenUsageTracker()?.snapshot()
      if (summary) {
        logMentionReplyTokenUsage({
          groupId: msg.groupId,
          messageId: msg.messageId,
          mode,
          durationMs: Date.now() - startedAt,
          summary,
        })
      }
    }
  })
}
