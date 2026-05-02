import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { createAgentChatFn, agentModel } from '../agent/runtime.js'
import { runAgentLoop } from '../agent/loop.js'
import { createProactiveAgentTools } from '../agent/tools.js'
import { buildSystemPrompt } from './agent-session.js'
import { createSceneAgentContext } from '../agent/scene-agent-context-store.js'
import { makeQqGroupSceneId } from '../runtime/agent-runtime-types.js'
import { maybeCompactConversation } from '../conversation/compaction.js'
import { withLlmTrace } from '../agent/llm-trace.js'
import { buildContextFrame, type ContextFrameSourceRefs } from '../agent/context-frame.js'
import {
  dispatchProactiveSend,
  type ProactiveSendActionExecutor,
} from '../runtime/proactive-send-dispatcher.js'
import { createLogger } from '../logger.js'

const PROACTIVE_INSTRUCTION = loadPrompt('./prompts/proactive-wakeup.md')
const PROACTIVE_SYSTEM_PROMPT_VERSION = 'proactive-system-prompt:v1'
const log = createLogger('PROACTIVE')

export interface ProactiveGroupSessionParams {
  groupId: number
  /** 论坛/外部输入摘要。null 表示没有外部输入,agent 默认应该 wait。 */
  forumDigest: string | null
  /** 触发本次唤醒的时刻,作为 opportunityId 的一部分,保证去重。 */
  triggeredAt: Date
  /**
   * Phase 0:proactive_send 必须经过 ActionIntent + Barrier + Executor + ActionRecord
   * 链路。actionExecutor 由 index.ts 注入(同一个实例,同一个 messageSender)。
   */
  actionExecutor: ProactiveSendActionExecutor
}

export async function runProactiveGroupSession(params: ProactiveGroupSessionParams): Promise<void> {
  const sceneId = makeQqGroupSceneId(params.groupId)
  const context = await createSceneAgentContext({ sceneId })

  const wakeupContent = params.forumDigest
    ? `[定时唤醒]\n以下是最新论坛动态摘要,供你参考是否有值得分享的内容:\n\n${params.forumDigest}`
    : '[定时唤醒] 系统定期唤醒,无外部输入。默认 wait,除非你从最近群聊里看到了明确想发言的契机。'

  await context.appendUserMessage({ role: 'user', content: wakeupContent })

  const profile = getAgentProfile(params.groupId)
  const systemPrompt = buildSystemPrompt(profile.persona, PROACTIVE_INSTRUCTION)

  let sendAttempts = 0
  let sendSuccesses = 0
  let sendDryRuns = 0
  let sendSuppressed = 0
  let waitInvoked = false

  const opportunityId = `proactive:${sceneId}:${params.triggeredAt.getTime()}`

  const tools = createProactiveAgentTools(params.groupId, {
    sendGroupMessage: async (text) => {
      sendAttempts += 1
      // Phase 0: 不再直调 sendGroupReply。走完整的 ActionIntent + Barrier 链。
      // Barrier 默认对 send_group_message 压成 dry_run/suppressed (Phase 10 前)。
      const result = await dispatchProactiveSend(
        {
          groupId: params.groupId,
          text,
          wakeupAt: params.triggeredAt,
          proactiveSessionId: opportunityId,
        },
        { actionExecutor: params.actionExecutor },
      )
      switch (result.deliveryResult) {
        case 'sent':
        case 'acked':
          sendSuccesses += 1
          // CLAUDE.md 不变量 #3:只有真发出去才落 model role 历史
          await context.appendAssistantTurn({ role: 'model', content: text })
          return { outcome: 'sent', toolResultText: '消息已发送' }
        case 'dry_run':
          sendDryRuns += 1
          return {
            outcome: 'dry_run',
            toolResultText: '消息进入 dry-run (barrier policy)；未真正发送，未写入历史。本轮唤醒可视为已表态。',
          }
        case 'suppressed':
        case 'skipped':
          sendSuppressed += 1
          return {
            outcome: 'suppressed',
            toolResultText: `消息被 barrier 抑制 (${result.reason})；未发送，未写入历史。`,
          }
        case 'failed':
          return {
            outcome: 'failed',
            toolResultText: `发送失败: ${result.reason}`,
          }
        default:
          return {
            outcome: 'failed',
            toolResultText: `unexpected delivery state: ${result.deliveryResult}`,
          }
      }
    },
    onWait: () => {
      waitInvoked = true
    },
  })

  const snapshot = await context.getSnapshot()
  const sourceRefs: ContextFrameSourceRefs = {
    sourceKind: 'proactive_wakeup',
    includedActionRecordIds: [],
    compactionSegmentIds: [],
  }
  const contextFrame = buildContextFrame({
    sceneId,
    opportunityId,
    systemPromptVersion: PROACTIVE_SYSTEM_PROMPT_VERSION,
    systemPrompt,
    initialHistory: snapshot.messages,
    sourceRefs,
    provider: process.env.LLM_DEFAULT_PROVIDER ?? 'openai-compatible',
    model: agentModel,
  })

  const chatFn = withLlmTrace(createAgentChatFn({ reasoningEffort: 'medium' }), params.groupId, contextFrame)

  const result = await runAgentLoop({
    systemPrompt,
    context,
    chatFn,
    tools: tools.declarations,
    executors: tools.executors,
    // proactive 没有 final_answer 终止工具,loop 必然跑到 maxSteps 或 implicit_text fallback。
    // 限到 3 步:典型流程是 db_read → proactive_send/wait → (浪费一步)。
    maxSteps: 3,
    allowImplicitText: false,
    warningTimeMs: profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
    maxAnswerChars: profile.agentMaxAnswerChars,
  })

  // outcome 由 closure 计数器决定,而不是 result.state——proactive 路径没有终止工具,
  // result.state 永远是 'fallback' 或 'aborted',无法区分各种情况。
  const outcome: 'sent' | 'dry_run' | 'suppressed' | 'waited' | 'idle' =
    sendSuccesses > 0 ? 'sent'
    : sendDryRuns > 0 ? 'dry_run'
    : sendSuppressed > 0 ? 'suppressed'
    : waitInvoked ? 'waited'
    : 'idle'

  log.info(
    {
      direction: 'internal',
      actor: 'bot',
      category: 'proactive_wakeup',
      flow: 'proactive_session',
      groupId: params.groupId,
      hasForumDigest: params.forumDigest != null,
      outcome,
      sendAttempts,
      sendSuccesses,
      sendDryRuns,
      sendSuppressed,
      waitInvoked,
      loopState: result.state,
      loopReason: 'reason' in result ? result.reason : undefined,
    },
    'proactive_session_result',
  )

  try {
    await maybeCompactConversation(context)
  } catch (err) {
    log.warn({ err, groupId: params.groupId }, 'proactive compaction failed')
  }
}
