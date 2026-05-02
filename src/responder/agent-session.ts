import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop, type EphemeralSuffixProvider } from '../agent/loop.js'
import { createAgentChatFn } from '../agent/runtime.js'
import { withLlmTrace } from '../agent/llm-trace.js'
import type { ContextFrame } from '../agent/context-frame.js'
import type { AgentContext } from '../agent/agent-context.js'
import type { AgentLoopResult } from '../agent/types.js'

export interface AgentSessionParams {
  groupId: number
  dbToolsEnabled?: boolean
  persona: string
  instruction: string
  /** 永续上下文真身。loop 在 context 上每轮 chat、append tool_calls/results。 */
  context: AgentContext
  maxSteps?: number
  allowImplicitText?: boolean
  warningTimeMs?: number
  maxAnswerChars?: number
  contextFrame?: ContextFrame
  /**
   * Phase 1d: per-call 临时附加消息(volatile tail)。reactive @ 路径用来注入
   * 最近 1h 内的 inner_journal。永远不写回 AgentContext。
   */
  ephemeralSuffix?: EphemeralSuffixProvider
}

export function buildSystemPrompt(persona: string, instruction: string): string {
  return [
    '[统一认知基座]',
    persona,
    '',
    '[任务约束]',
    instruction,
  ].join('\n')
}

export async function runAgentSession(params: AgentSessionParams): Promise<AgentLoopResult> {
  const { declarations, executors } = createAgentTools(params.groupId, {
    dbToolsEnabled: params.dbToolsEnabled,
  })
  const chatFn = withLlmTrace(createAgentChatFn({ reasoningEffort: 'medium' }), params.groupId, params.contextFrame)
  const systemPrompt = buildSystemPrompt(params.persona, params.instruction)

  return runAgentLoop({
    systemPrompt,
    context: params.context,
    chatFn,
    tools: declarations,
    executors,
    maxSteps: params.maxSteps,
    allowImplicitText: params.allowImplicitText,
    warningTimeMs: params.warningTimeMs,
    maxAnswerChars: params.maxAnswerChars,
    ephemeralSuffix: params.ephemeralSuffix,
  })
}
