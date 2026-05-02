import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { getCurrentTokenUsageTracker, runWithTokenUsageTracking } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import { buildContextFrame, type ContextFrame, type ContextFrameSourceRefs } from '../agent/context-frame.js'
import { agentModel } from '../agent/runtime.js'
import type { ReplyOpportunity } from '../runtime/reply-decision-types.js'
import { makeQqGroupSceneId, makeQqPrivateSceneId, type SceneId } from '../runtime/agent-runtime-types.js'
import type { AgentContext } from '../agent/agent-context.js'
import { ingestSceneMessages } from '../agent/scene-message-ingestor.js'
import type { IncomingMessage } from './pipeline.js'
import { extractResolvedTriggerText } from './context-builder.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'
import { buildSystemPrompt, runAgentSession } from './agent-session.js'
import type { AgentMessage } from '../agent/types.js'
import { innerJournalStore } from '../world-model/inner-journal-store.js'

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
  systemPrompt: string
  /** 取自 agentContext.getSnapshot().messages, 反映本轮 LLM 看到的真实历史 */
  initialHistory: AgentMessage[]
  messageCursorStart?: number
  messageCursorEnd?: number
  includedActionRecordIds?: string[]
  maxActionAnchor?: number
}): ContextFrame {
  const sceneId = input.generationContext?.sceneId ?? fallbackSceneId(input.msg)
  const sourceRefs: ContextFrameSourceRefs = {
    sourceKind: input.generationContext?.sourceKind ?? 'legacy_fallback',
    deliveryMode: input.generationContext?.deliveryMode,
    triggerMessageRowId: input.generationContext?.triggerMessageRowId ?? input.msg.messageRowId,
    incorporatedMessageRowId: input.generationContext?.incorporatedMessageRowId ?? input.msg.messageRowId,
    triggerMessageId: input.generationContext?.triggerMessageId ?? input.msg.messageId,
    incorporatedMessageId: input.generationContext?.incorporatedMessageId ?? input.msg.messageId,
    messageCursorStart: input.messageCursorStart,
    messageCursorEnd: input.messageCursorEnd,
    includedActionRecordIds: input.includedActionRecordIds ?? [],
    maxActionAnchor: input.maxActionAnchor,
    compactionSegmentIds: [],
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
  context: AgentContext,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
  allowImplicitText = true,
  generationContext?: ReplyGenerationContext,
): Promise<string | null> {
  const mediaDeadlineAt = Date.now() + 15_000

  // Phase C: 把 cursor 之后、当前 trigger 之前的群消息和已 sent action_records
  // 一次性 append 进 context (增量摄入)。当前 trigger 自身随后单独以带 prefix
  // 的 user message 入账, 让模型清楚知道要回复的是哪一条。
  await ingestSceneMessages({
    context,
    sceneKind: msg.sceneKind ?? 'qq_group',
    sceneExternalId: msg.sceneExternalId ?? msg.groupId,
    sceneId: (generationContext?.sceneId ?? fallbackSceneId(msg)) as SceneId,
    groupId: msg.groupId,
    upToExclusiveRowId: msg.messageRowId,
  })

  const triggerText = await extractResolvedTriggerText(
    msg.groupId,
    msg.messageId,
    msg.segments,
    { mediaDeadlineAt },
    { sceneKind: msg.sceneKind, sceneExternalId: msg.sceneExternalId },
  )
  const triggerNickname = msg.senderNickname ?? String(msg.senderId)
  await context.appendUserMessage({
    role: 'user',
    content: `[当前要回复的消息]\n${triggerNickname}: ${triggerText}`,
  })
  if (msg.messageRowId != null) {
    await context.setLastObservedMessageRowId(msg.messageRowId)
  }

  const snapshot = await context.getSnapshot()
  const systemPrompt = buildSystemPrompt(persona, REPLY_INSTRUCTION)
  const contextFrame = buildMentionContextFrame({
    msg,
    generationContext,
    systemPrompt,
    initialHistory: snapshot.messages,
  })

  // Phase 1d: 注入最近 1h 内的 inner_journal (如果有)。每个 step 都用同一段 suffix。
  // 不写回 AgentContext,符合 perpetual context 不变量。
  // 只取 1h 内的:避免老 journal 反复污染新回复;1h 没新 journal 说明 scene 不活跃,
  // 那次 reactive @ 直接走纯 prefix 即可。
  const reactiveSceneId = (generationContext?.sceneId ?? fallbackSceneId(msg)) as string
  const ephemeralSuffix = await buildInnerJournalSuffix(reactiveSceneId)

  const result = await runAgentSession({
    groupId: msg.groupId,
    dbToolsEnabled: msg.sceneKind !== 'qq_private',
    persona,
    instruction: REPLY_INSTRUCTION,
    context,
    maxSteps,
    allowImplicitText,
    warningTimeMs,
    maxAnswerChars,
    contextFrame,
    ephemeralSuffix,
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

/**
 * Phase 1d: 取最近 1h 内的最新 inner_journal,构造 ephemeralSuffix 给 reactive @ 用。
 * 1h 没新 journal → 返回空数组(等价于不注入,reactive @ 走纯 prefix)。
 *
 * 故意不抛错: journal store 出问题不应该阻塞 reactive @。
 */
async function buildInnerJournalSuffix(sceneId: string): Promise<AgentMessage[]> {
  try {
    const recent = await innerJournalStore.last({ sceneId, limit: 1, withinHours: 1 })
    if (recent.length === 0) return []
    const entry = recent[0]
    if (!entry) return []
    return [{
      role: 'user',
      content: `[内部状态]\n${entry.content}`,
    }]
  } catch (err) {
    log.warn({ err, sceneId }, 'inner_journal_suffix_failed')
    return []
  }
}

export interface GenerateMentionReplyOptions {
  /** 必传:已 load 好的 scene AgentContext。
   *  passive-mention-processor 装配并传入,reply 链路只在这上面 append/run。 */
  context: AgentContext
}

export async function generateMentionReply(
  msg: IncomingMessage,
  options: GenerateMentionReplyOptions,
  generationContext?: ReplyGenerationContext,
): Promise<string | null> {
  return runWithTokenUsageTracking(async () => {
    const startedAt = Date.now()
    const mode: 'agent' = 'agent'

    try {
      const profile = getAgentProfile(msg.groupId)

      const reply = await agentReply(
        msg,
        profile.persona,
        options.context,
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

