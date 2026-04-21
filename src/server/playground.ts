import OpenAI from 'openai'
import { createTraceRecorder, type RunTrace } from '../agent/trace.js'
import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createAgentOpenAIConfig, createOpenAIChatFn } from '../agent/openai-compat.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { buildContext } from '../responder/context-builder.js'
import { buildSystemPrompt } from '../responder/agent-session.js'
import { buildReplyHistory } from '../responder/reply-history.js'
import type { RouteHandler } from './http.js'
import type { AgentMessage, AgentTurnResult, ToolCall, ToolResult } from '../agent/types.js'
import { prisma } from '../database/client.js'

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

interface ReplayPayload {
  traceId: number
  groupId: string
  model: string
  systemPrompt: string
  history: Array<{ role: string; content: string }>
  tools: string[]
}

interface ReplayBody extends ReplayPayload {}

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
  const mediaDeadlineAt = Date.now() + 15_000
  const { contextText: context } = await (deps.buildContext ?? buildContext)(fakeMsg, contextLimit, { mediaDeadlineAt })
  traceRecorder.phaseFinished({
    phase: 'load_context',
    summary: context ? 'context loaded' : 'no context available',
    raw: context,
  })
  const initialHistory: AgentMessage[] = buildReplyHistory(context, message)

  const { declarations, executors } = (deps.createAgentTools ?? createAgentTools)(groupIdNum)
  const chatFn = deps.chatFn ?? createOpenAIChatFn(_agentClient, _agentModel)

  const systemPrompt = buildSystemPrompt(profile.persona, REPLY_INSTRUCTION)
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

function ensureObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage)
  }
  return value as Record<string, unknown>
}

function serializeHistoryForEditor(history: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return []

  return history.flatMap((item): Array<{ role: string; content: string }> => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const role = typeof row.role === 'string' ? row.role : ''
    if (!role) return []

    if (role === 'user' || role === 'model') {
      const content = typeof row.content === 'string' ? row.content : ''
      return [{ role, content }]
    }

    if (role === 'tool_calls') {
      return [
        {
          role,
          content: JSON.stringify(Array.isArray(row.calls) ? row.calls : [], null, 2),
        },
      ]
    }

    if (role === 'tool_results') {
      return [
        {
          role,
          content: JSON.stringify(Array.isArray(row.results) ? row.results : [], null, 2),
        },
      ]
    }

    return []
  })
}

function parseReplayHistory(input: Array<{ role: string; content: string }>): AgentMessage[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('history 至少保留一条消息')
  }

  return input.map((item) => {
    const role = (item.role ?? '').trim()
    const content = typeof item.content === 'string' ? item.content : ''

    if (!role) throw new Error('history.role 不能为空')

    if (role === 'user') return { role: 'user', content }
    if (role === 'model' || role === 'assistant') return { role: 'model', content }

    if (role === 'tool_calls') {
      let calls: ToolCall[] = []
      try {
        const parsed = JSON.parse(content) as unknown
        if (Array.isArray(parsed)) {
          calls = parsed.flatMap((v): ToolCall[] => {
            if (!v || typeof v !== 'object') return []
            const row = v as Record<string, unknown>
            if (typeof row.id !== 'string' || typeof row.name !== 'string') return []
            return [{ id: row.id, name: row.name, args: typeof row.args === 'object' && row.args ? (row.args as Record<string, unknown>) : {} }]
          })
        }
      } catch {
        throw new Error('tool_calls 的 content 必须是 JSON 数组')
      }
      return { role: 'tool_calls', calls }
    }

    if (role === 'tool_results') {
      let results: ToolResult[] = []
      try {
        const parsed = JSON.parse(content) as unknown
        if (Array.isArray(parsed)) {
          results = parsed.flatMap((v): ToolResult[] => {
            if (!v || typeof v !== 'object') return []
            const row = v as Record<string, unknown>
            if (typeof row.callId !== 'string' || typeof row.name !== 'string') return []
            return [
              {
                callId: row.callId,
                name: row.name,
                output: typeof row.output === 'string' ? row.output : '',
                error: typeof row.error === 'string' ? row.error : undefined,
              },
            ]
          })
        }
      } catch {
        throw new Error('tool_results 的 content 必须是 JSON 数组')
      }
      return { role: 'tool_results', results }
    }

    throw new Error(`不支持的 history role: ${role}`)
  })
}

function getLastUserText(history: Array<{ role: string; content: string }>): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i]
    if (item?.role === 'user') return item.content.slice(0, 500)
  }
  return 'strict replay'
}

export async function getReplayPayload(traceId: number): Promise<{
  traceId: number
  groupId: string
  model: string
  systemPrompt: string
  history: Array<{ role: string; content: string }>
  tools: string[]
  meta: {
    createdAt: string
    durationMs: number
    error?: string | null
    source: 'trace'
    toolsSource: 'trace' | 'dynamic'
  }
}> {
  const row = await prisma.llmTrace.findUnique({ where: { id: traceId } })
  if (!row) throw new Error(`trace #${traceId} 不存在`)

  const parsedInput = ensureObject(row.input, 'trace.input 格式异常')
  const systemPrompt = typeof parsedInput.systemPrompt === 'string' ? parsedInput.systemPrompt : ''
  const history = serializeHistoryForEditor(parsedInput.history)

  const toolNamesInTrace =
    Array.isArray(parsedInput.tools) && parsedInput.tools.every((v) => typeof v === 'string')
      ? (parsedInput.tools as string[])
      : null

  const dynamicTools = createAgentTools(Number(row.groupId)).declarations.map((tool) => tool.name)

  return {
    traceId: row.id,
    groupId: row.groupId.toString(),
    model: row.model ?? _agentModel,
    systemPrompt,
    history,
    tools: toolNamesInTrace ?? dynamicTools,
    meta: {
      createdAt: row.createdAt.toISOString(),
      durationMs: row.durationMs,
      error: row.error,
      source: 'trace',
      toolsSource: toolNamesInTrace ? 'trace' : 'dynamic',
    },
  }
}

export async function runStrictReplay(body: ReplayBody): Promise<PlaygroundResult> {
  const traceId = Number(body.traceId)
  if (!Number.isFinite(traceId)) throw new Error('traceId 无效')

  const groupIdNum = Number(body.groupId)
  if (!Number.isFinite(groupIdNum)) throw new Error('groupId 无效')

  const model = (body.model ?? '').trim() || _agentModel
  const systemPrompt = (body.systemPrompt ?? '').trim()
  if (!systemPrompt) throw new Error('systemPrompt 不能为空')

  const requestedTools = Array.isArray(body.tools) ? body.tools.map((v) => v.trim()).filter(Boolean) : []
  const replayHistoryRaw = Array.isArray(body.history) ? body.history : []
  const initialHistory = parseReplayHistory(replayHistoryRaw)

  const { declarations, executors } = createAgentTools(groupIdNum)
  const declaredNames = new Set(declarations.map((tool) => tool.name))
  const unknownTools = requestedTools.filter((tool) => !declaredNames.has(tool))
  if (unknownTools.length > 0) {
    throw new Error(`tools 不存在: ${unknownTools.join(', ')}`)
  }

  const selectedToolNames = new Set(requestedTools)
  const selectedDeclarations = declarations.filter((tool) => selectedToolNames.has(tool.name))
  const selectedExecutors = Object.fromEntries(
    Object.entries(executors).filter(([name]) => selectedToolNames.has(name)),
  )

  const startedAt = Date.now()
  const traceRecorder = createTraceRecorder({
    runId: `replay_${traceId}_${groupIdNum}_${startedAt}`,
    groupId: groupIdNum,
    senderName: 'replay-debugger',
    userMessage: getLastUserText(replayHistoryRaw),
  })
  traceRecorder.phaseStarted('receive', 'strict replay request received')
  traceRecorder.phaseFinished({
    phase: 'receive',
    summary: 'strict replay request validated',
    raw: { traceId, groupId: groupIdNum, model, tools: requestedTools },
  })
  traceRecorder.phaseStarted('plan', 'strict replay plan prepared')
  traceRecorder.phaseFinished({
    phase: 'plan',
    summary: 'using edited prompt/history/tools',
  })

  const chatFn = createOpenAIChatFn(
    new OpenAI({ baseURL: _agentConfig.baseURL, apiKey: _agentConfig.apiKey }),
    model,
  )

  const steps: PlaygroundStep[] = []
  const tracedExecutors = Object.fromEntries(
    Object.entries(selectedExecutors).map(([name, exec]) => [
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
    tools: selectedDeclarations,
    executors: tracedExecutors,
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
      messages: replayHistoryRaw.map((m) => ({ role: m.role, content: m.content })),
      tools: selectedDeclarations.map((tool) => tool.name),
    },
  }
}

export const handleReplayTraceGet: RouteHandler = async (params) => {
  const traceId = Number(params.id)
  if (!Number.isFinite(traceId)) {
    throw new Error('traceId 无效')
  }
  return getReplayPayload(traceId)
}

export const handlePlaygroundReplay: RouteHandler = async (_params, rawBody) => {
  return runStrictReplay(rawBody as ReplayBody)
}
