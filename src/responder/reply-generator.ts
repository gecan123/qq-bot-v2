import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { getCurrentTokenUsageTracker, runWithTokenUsageTracking } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import { buildContextFrame, type ContextFrame, type ContextFrameSourceRefs } from '../agent/context-frame.js'
import { agentModel } from '../agent/runtime.js'
import type { ReplyOpportunity } from '../runtime/reply-decision-types.js'
import { makeQqGroupSceneId, makeQqPrivateSceneId } from '../runtime/agent-runtime-types.js'
import type { IncomingMessage } from './pipeline.js'
import { buildContext, extractResolvedTriggerText } from './context-builder.js'
import { buildReplyHistory } from './reply-history.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'
import { buildSystemPrompt, runAgentSession } from './agent-session.js'

const REPLY_INSTRUCTION = loadPrompt('./prompts/reply-instruction.md')
const log = createLogger('REPLY')
const REPLY_SYSTEM_PROMPT_VERSION = 'reply-system-prompt:v1'

export type ReplyGenerationContext = Pick<
  ReplyOpportunity,
  | 'sceneId'
  | 'opportunityId'
  | 'sourceKind'
  | 'deliveryMode'
  | 'triggerMessageRowId'
  | 'triggerMessageId'
  | 'incorporatedMessageRowId'
  | 'incorporatedMessageId'
>

function fallbackSceneId(msg: IncomingMessage): string {
  if (msg.sceneId) return msg.sceneId
  if (msg.sceneKind === 'qq_private') {
    return makeQqPrivateSceneId(Number(msg.sceneExternalId ?? msg.senderId))
  }
  return makeQqGroupSceneId(Number(msg.sceneExternalId ?? msg.groupId))
}

function fallbackOpportunityId(msg: IncomingMessage, sceneId: string): string {
  return `legacy:${sceneId}:${msg.messageRowId ?? msg.messageId}:mention`
}

export function buildMentionContextFrame(input: {
  msg: IncomingMessage
  generationContext?: ReplyGenerationContext
  contextResult: Awaited<ReturnType<typeof buildContext>>
  systemPrompt: string
  initialHistory: ReturnType<typeof buildReplyHistory>
}): ContextFrame {
  const sceneId = input.generationContext?.sceneId ?? fallbackSceneId(input.msg)
  const sourceRefs: ContextFrameSourceRefs = {
    sourceKind: input.generationContext?.sourceKind ?? 'legacy_fallback',
    deliveryMode: input.generationContext?.deliveryMode,
    triggerMessageRowId: input.generationContext?.triggerMessageRowId ?? input.msg.messageRowId,
    incorporatedMessageRowId: input.generationContext?.incorporatedMessageRowId ?? input.msg.messageRowId,
    triggerMessageId: input.generationContext?.triggerMessageId ?? input.msg.messageId,
    incorporatedMessageId: input.generationContext?.incorporatedMessageId ?? input.msg.messageId,
    messageCursorStart: input.contextResult.messageCursorStart,
    messageCursorEnd: input.contextResult.messageCursorEnd,
    includedActionRecordIds: input.contextResult.includedActionRecordIds ?? [],
    maxActionAnchor: input.contextResult.maxActionAnchor,
    compactionSegmentIds: input.contextResult.compactionSegmentIds ?? [],
  }

  return buildContextFrame({
    sceneId,
    opportunityId: input.generationContext?.opportunityId ?? fallbackOpportunityId(input.msg, sceneId),
    systemPromptVersion: REPLY_SYSTEM_PROMPT_VERSION,
    systemPrompt: input.systemPrompt,
    initialHistory: input.initialHistory,
    sourceRefs,
    provider: process.env.LLM_DEFAULT_PROVIDER ?? 'openai-compatible',
    model: agentModel,
  })
}

async function agentReply(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
  allowImplicitText = true,
  generationContext?: ReplyGenerationContext,
): Promise<string | null> {
  const mediaDeadlineAt = Date.now() + 15_000
  const contextResult = await buildContext(msg, contextLimit, { mediaDeadlineAt })
  const triggerText = await extractResolvedTriggerText(msg.groupId, msg.messageId, msg.segments, { mediaDeadlineAt }, {
    sceneKind: msg.sceneKind,
    sceneExternalId: msg.sceneExternalId,
  })
  const initialHistory = buildReplyHistory({
    windowHistory: contextResult.history,
    compactedSummary: contextResult.compactedSummary,
    trigger: triggerText,
  })
  const systemPrompt = buildSystemPrompt(persona, REPLY_INSTRUCTION)
  const contextFrame = buildMentionContextFrame({
    msg,
    generationContext,
    contextResult,
    systemPrompt,
    initialHistory,
  })

  const result = await runAgentSession({
    groupId: msg.groupId,
    dbToolsEnabled: msg.sceneKind !== 'qq_private',
    persona,
    instruction: REPLY_INSTRUCTION,
    initialHistory,
    maxSteps,
    allowImplicitText,
    warningTimeMs,
    maxAnswerChars,
    contextFrame,
  })

  log.info(
    {
      direction: 'internal',
      actor: 'bot',
      category: 'mention_reply',
      flow: 'reply_generation',
      groupId: msg.groupId,
      messageId: msg.messageId,
      senderId: msg.senderId,
      senderNickname: msg.senderNickname,
      state: result.state,
      termination: result.state === 'final' ? result.termination : undefined,
      reason: 'reason' in result ? result.reason : undefined,
    },
    'at_mention_agent_result',
  )

  if (result.state === 'final') return result.answer
  return null
}

export async function generateMentionReply(
  msg: IncomingMessage,
  generationContext?: ReplyGenerationContext,
): Promise<string | null> {
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
        true,
        generationContext,
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

