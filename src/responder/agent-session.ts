import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createAgentChatFn } from '../agent/runtime.js'
import { withLlmTrace } from '../agent/llm-trace.js'
import type { AgentLoopResult, AgentMessage } from '../agent/types.js'

export interface AgentSessionParams {
  groupId: number
  persona: string
  instruction: string
  initialHistory: AgentMessage[]
  maxSteps?: number
  allowImplicitText?: boolean
  warningTimeMs?: number
  maxAnswerChars?: number
}

export function buildSystemPrompt(persona: string, instruction: string): string {
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return [
    `当前时间：${now}`,
    '',
    '[群聊人格基座]',
    persona,
    '',
    '[任务约束]',
    instruction,
  ].join('\n')
}

export async function runAgentSession(params: AgentSessionParams): Promise<AgentLoopResult> {
  const { declarations, executors } = createAgentTools(params.groupId)
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
