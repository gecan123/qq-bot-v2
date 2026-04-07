import OpenAI from 'openai'
import { createTraceRecorder, type RunTrace } from '../agent/trace.js'
import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createAgentOpenAIConfig, createOpenAIChatFn } from '../agent/openai-compat.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { buildContext } from '../responder/context-builder.js'
import type { RouteHandler } from './http.js'
import type { AgentMessage, AgentTurnResult } from '../agent/types.js'

const REPLY_INSTRUCTION = loadPrompt('./prompts/reply-instruction.md')
const _agentConfig = createAgentOpenAIConfig()
const _agentClient = new OpenAI({ baseURL: _agentConfig.baseURL, apiKey: _agentConfig.apiKey })
const _agentModel = _agentConfig.model

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
  finalAnswerPayload?: Record<string, unknown>
  steps: PlaygroundStep[]
  elapsedMs: number
  trace: RunTrace
  llmContext: {
    systemPrompt: string
    messages: Array<{ role: string; content: string }>
    tools: string[]
  }
}

interface PlaygroundBody {
  groupId?: string
  message?: string
  senderId?: string
  senderName?: string
}

interface PlaygroundProfile {
  persona: string
  replyContextMessages?: number
  agentMaxSteps?: number
  agentWarningTimeMs?: number
  agentMaxTimeMs?: number
  agentMaxAnswerChars?: number
}

interface PlaygroundDeps {
  buildContext?: typeof buildContext
  getAgentProfile?: (groupId: number) => PlaygroundProfile
  createAgentTools?: typeof createAgentTools
  chatFn?: (params: {
    systemPrompt: string
    history: import('../agent/types.js').AgentMessage[]
    tools: import('../agent/types.js').AgentToolDeclaration[]
  }) => Promise<AgentTurnResult>
  nowFactory?: () => string
}

function getNowString() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export async function runPlayground(body: PlaygroundBody, deps: PlaygroundDeps = {}): Promise<PlaygroundResult> {
  const groupIdNum = Number(body.groupId)
  if (!body.groupId || !Number.isFinite(groupIdNum)) {
    throw new Error('groupId 必须为有效数字')
  }
  const message = (body.message ?? '').trim()
  if (!message) {
    throw new Error('message 不能为空')
  }

  const startedAt = Date.now()
  const senderName = body.senderName ?? '测试用户'
  const traceRecorder = createTraceRecorder({
    runId: `playground_${groupIdNum}_${startedAt}`,
    groupId: groupIdNum,
    senderName,
    userMessage: message,
  })
  traceRecorder.phaseStarted('receive', 'playground request received')
  traceRecorder.phaseFinished({
    phase: 'receive',
    summary: 'request validated',
    raw: { groupId: groupIdNum, senderName, message },
  })

  const profile = (deps.getAgentProfile ?? getAgentProfile)(groupIdNum)
  const contextLimit = profile.replyContextMessages ?? 20

  const fakeMsg = {
    groupId: groupIdNum,
    messageId: 0,
    senderId: Number(body.senderId ?? '0') || 0,
    senderNickname: senderName,
    segments: [{ type: 'text' as const, content: message }],
  }

  traceRecorder.phaseStarted('load_context', 'building context')
  const context = await (deps.buildContext ?? buildContext)(fakeMsg, contextLimit)
  traceRecorder.phaseFinished({
    phase: 'load_context',
    summary: context ? 'context loaded' : 'no context available',
    raw: context,
  })
  const contextContent = context
    ? `[群聊背景]\n${context}`
    : '[群聊背景]\n（暂无近期消息记录）'

  const initialHistory: AgentMessage[] = [
    { role: 'user', content: contextContent },
    { role: 'model', content: '好的。' },
    { role: 'user', content: message },
  ]

  const { declarations, executors } = (deps.createAgentTools ?? createAgentTools)(groupIdNum)
  const chatFn = deps.chatFn ?? createOpenAIChatFn(_agentClient, _agentModel)

  const now = (deps.nowFactory ?? getNowString)()
  const systemPrompt = [
    `当前时间：${now}`,
    '',
    '[群聊人格基座]',
    profile.persona,
    '',
    '[任务约束]',
    REPLY_INSTRUCTION,
  ].join('\n')
  traceRecorder.phaseStarted('plan', 'preparing system prompt and tool context')
  traceRecorder.phaseFinished({
    phase: 'plan',
    summary: 'system prompt and tools prepared',
    raw: { tools: declarations.map((tool) => tool.name) },
  })

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
    initialHistory,
    chatFn,
    tools: declarations,
    executors: tracedExecutors,
    maxSteps: profile.agentMaxSteps,
    warningTimeMs: profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
    maxAnswerChars: profile.agentMaxAnswerChars,
    traceRecorder,
  })

  return {
    state: result.state,
    answer: result.state === 'final' ? result.answer : undefined,
    reason: result.state !== 'final' && 'reason' in result ? result.reason : undefined,
    finalAnswerPayload: result.state === 'final' ? result.finalAnswerPayload : undefined,
    steps,
    elapsedMs: Date.now() - startedAt,
    trace: result.trace ?? traceRecorder.finish({
      finalState: result.state,
      finalAnswer: result.state === 'final' ? result.answer : undefined,
      terminationReason: 'runtime_error',
    }),
    llmContext: {
      systemPrompt,
      messages: initialHistory.flatMap((m) =>
        m.role === 'user' || m.role === 'model' ? [{ role: m.role, content: m.content }] : [],
      ),
      tools: declarations.map((tool) => tool.name),
    },
  }
}

export const handlePlaygroundRun: RouteHandler = async (_params, rawBody) => {
  return runPlayground(rawBody as PlaygroundBody)
}
