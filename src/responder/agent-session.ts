import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createAgentChatFn } from '../agent/runtime.js'
import { withLlmTrace } from '../agent/llm-trace.js'
import type { AgentLoopResult, AgentMessage } from '../agent/types.js'

export interface AgentSessionParams {
  groupId: number
  dbToolsEnabled?: boolean
  persona: string
  instruction: string
  initialHistory: AgentMessage[]
  maxSteps?: number
  allowImplicitText?: boolean
  warningTimeMs?: number
  maxAnswerChars?: number
}

export function buildSystemPrompt(persona: string, instruction: string): string {
  return [
    '[群聊人格基座]',
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
  const chatFn = withLlmTrace(createAgentChatFn({ reasoningEffort: 'medium' }), params.groupId)
  const systemPrompt = buildSystemPrompt(params.persona, params.instruction)

  return runAgentLoop({
    systemPrompt,
    initialHistory: params.initialHistory,
    chatFn,
    tools: declarations,
    executors,
    maxSteps: params.maxSteps,
    allowImplicitText: params.allowImplicitText,
    warningTimeMs: params.warningTimeMs,
    maxAnswerChars: params.maxAnswerChars,
  })
}
