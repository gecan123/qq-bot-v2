import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createOpenAIAgentAdapter } from '../agent/openai-agent-adapter.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { buildContext } from '../responder/context-builder.js'
import type { RouteHandler } from './http.js'

const REPLY_INSTRUCTION = loadPrompt('./prompts/reply-instruction.md')

export interface PlaygroundStep {
  type: 'tool_call' | 'tool_result'
  name: string
  input?: unknown
  output?: string
  error?: string
  durationMs?: number
}

export interface PlaygroundResult {
  state: 'final' | 'fallback' | 'aborted'
  answer?: string
  reason?: string
  steps: PlaygroundStep[]
  elapsedMs: number
}

interface PlaygroundBody {
  groupId?: string
  message?: string
  senderId?: string
  senderName?: string
}

export const handlePlaygroundRun: RouteHandler = async (_params, rawBody) => {
  const body = rawBody as PlaygroundBody

  const groupIdNum = Number(body.groupId)
  if (!body.groupId || !Number.isFinite(groupIdNum)) {
    throw new Error('groupId 必须为有效数字')
  }
  const message = (body.message ?? '').trim()
  if (!message) {
    throw new Error('message 不能为空')
  }

  const startedAt = Date.now()
  const profile = getAgentProfile(groupIdNum)
  const contextLimit = profile.replyContextMessages ?? 20

  const fakeMsg = {
    groupId: groupIdNum,
    messageId: 0,
    senderId: Number(body.senderId ?? '0') || 0,
    senderNickname: body.senderName ?? '测试用户',
    segments: [{ type: 'text' as const, content: message }],
  }

  const context = await buildContext(fakeMsg, contextLimit)
  const userMessage = context ? `${message}\n\n[群聊背景]\n${context}` : message

  const { declarations, executors } = createAgentTools(groupIdNum)
  const adapter = createOpenAIAgentAdapter()

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
    profile.persona,
    '',
    '[任务约束]',
    REPLY_INSTRUCTION,
  ].join('\n')

  const steps: PlaygroundStep[] = []

  const tracedExecutors = Object.fromEntries(
    Object.entries(executors).map(([name, exec]) => [
      name,
      async (args: Record<string, unknown>) => {
        steps.push({ type: 'tool_call', name, input: args })
        const callStart = Date.now()
        try {
          const output = await exec(args)
          steps.push({ type: 'tool_result', name, output, durationMs: Date.now() - callStart })
          return output
        } catch (err) {
          steps.push({ type: 'tool_result', name, error: String(err), durationMs: Date.now() - callStart })
          throw err
        }
      },
    ]),
  )

  const result = await runAgentLoop({
    systemPrompt,
    userMessage,
    adapter,
    tools: declarations,
    executors: tracedExecutors,
    maxSteps: profile.agentMaxSteps,
    warningTimeMs: profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
    maxAnswerChars: profile.agentMaxAnswerChars,
  })

  const response: PlaygroundResult = {
    state: result.state,
    answer: result.state === 'final' ? result.answer : undefined,
    reason: result.state !== 'final' && 'reason' in result ? result.reason : undefined,
    steps,
    elapsedMs: Date.now() - startedAt,
  }

  return response
}
