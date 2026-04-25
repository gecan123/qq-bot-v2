import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { getCurrentTokenUsageTracker, runWithTokenUsageTracking } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import type { IncomingMessage } from './pipeline.js'
import { buildContext, extractResolvedTriggerText } from './context-builder.js'
import { buildReplyHistory } from './reply-history.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'
import { runAgentSession } from './agent-session.js'

const REPLY_INSTRUCTION = loadPrompt('./prompts/reply-instruction.md')
const log = createLogger('REPLY')

export interface ProactiveCandidateReplyResult {
  text: string | null
  termination: string
}

async function agentReply(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
  allowImplicitText = true,
): Promise<string | null> {
  const mediaDeadlineAt = Date.now() + 15_000
  const { contextText } = await buildContext(msg, contextLimit, { mediaDeadlineAt })
  const triggerText = await extractResolvedTriggerText(msg.groupId, msg.messageId, msg.segments, { mediaDeadlineAt })
  const initialHistory = buildReplyHistory(contextText, triggerText)

  const result = await runAgentSession({
    groupId: msg.groupId,
    persona,
    instruction: REPLY_INSTRUCTION,
    initialHistory,
    maxSteps,
    allowImplicitText,
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

async function agentReplyWithTermination(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
  allowImplicitText = true,
): Promise<ProactiveCandidateReplyResult> {
  const mediaDeadlineAt = Date.now() + 15_000
  const { contextText } = await buildContext(msg, contextLimit, { mediaDeadlineAt })
  const triggerText = await extractResolvedTriggerText(msg.groupId, msg.messageId, msg.segments, { mediaDeadlineAt })
  const initialHistory = buildReplyHistory(contextText, triggerText)

  const result = await runAgentSession({
    groupId: msg.groupId,
    persona,
    instruction: REPLY_INSTRUCTION,
    initialHistory,
    maxSteps,
    allowImplicitText,
    warningTimeMs,
    maxAnswerChars,
  })

  log.info(
    { groupId: msg.groupId, state: result.state, reason: 'reason' in result ? result.reason : undefined },
    'at_mention_agent_result',
  )

  if (result.state === 'final') {
    return { text: result.answer, termination: result.termination }
  }
  return { text: null, termination: result.reason }
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

export async function generateProactiveCandidateReply(msg: IncomingMessage): Promise<ProactiveCandidateReplyResult> {
  return runWithTokenUsageTracking(async () => {
    const startedAt = Date.now()
    const mode: 'agent' = 'agent'

    try {
      const profile = getAgentProfile(msg.groupId)
      const contextLimit = profile.replyContextMessages ?? 20

      return agentReplyWithTermination(
        msg,
        profile.persona,
        contextLimit,
        profile.agentMaxSteps,
        profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
        profile.agentMaxAnswerChars,
        false,
      )
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
