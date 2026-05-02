import type { AgentLoopResult, AgentMessage, AgentToolDeclaration, AgentTurnResult, ToolCall, ToolResult } from './types.js'
import type { ToolExecutor } from './tools.js'
import type { TraceRecorder, TraceTerminationReason } from './trace.js'
import type { AgentContext } from './agent-context.js'
import { CONTROL_TOOL_NAMES, createAgentContext } from './agent-context.js'
import { buildLlmRequest } from './build-llm-request.js'
import { createLogger } from '../logger.js'

export type EphemeralSuffixProvider = AgentMessage[] | ((loopIndex: number) => AgentMessage[] | Promise<AgentMessage[]>)

type ChatFn = (params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
  loopIndex?: number
}) => Promise<AgentTurnResult>

const log = createLogger('AGENT')

export interface AgentLoopParams {
  systemPrompt: string
  /**
   * 永续上下文的真身。loop 每轮 chatFn 时取 snapshot;tool_calls/tool_results 写回 context。
   *
   * 控制工具(final_answer)**不**写 context — 由调用方在发送成功后 appendAssistantTurn,
   * 这样发送失败时历史里不会出现「假回复」。
   *
   * 不传时 loop 会创建一个临时内存 context 启动(用于测试和 userMessage 简化路径)。
   */
  context?: AgentContext
  /** 兼容旧调用:单条用户消息,等价于在临时 context 上 appendUserMessage 后再 run。 */
  userMessage?: string
  chatFn: ChatFn
  tools: AgentToolDeclaration[]
  executors: Record<string, ToolExecutor>
  maxSteps?: number
  allowImplicitText?: boolean
  /** 慢请求告警阈值(毫秒),仅告警不中断 */
  warningTimeMs?: number
  /** @deprecated 保留兼容;等价于 warningTimeMs */
  maxTimeMs?: number
  maxAnswerChars?: number
  traceRecorder?: TraceRecorder
  /**
   * 每个 loop step 临时附加到 history 末尾的消息(per-call,不写回 AgentContext)。
   *
   * - 数组:每步都用同一段 suffix
   * - 函数:接收 loopIndex,可以每步生成不同 suffix(例:第 1 步注入「内部状态」,后续步只用裸 history)
   *
   * 详见 `build-llm-request.ts`:此参数通过 buildLlmRequest 拼接到 snapshot.messages
   * 之后,**永远不进** scene_agent_contexts.snapshot——保 perpetual context 不变量。
   */
  ephemeralSuffix?: EphemeralSuffixProvider
}

interface StepDetail {
  step: number
  tool: string
  durationMs: number
  model?: string
}

function extractFinalAnswerText(call: ToolCall, maxAnswerChars: number): string {
  const replyText =
    (call.args['replyText'] as string | undefined) ??
    (call.args['text'] as string | undefined) ??
    ''
  return replyText.slice(0, maxAnswerChars)
}

async function executeLoop(params: AgentLoopParams, startTime: number): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    chatFn,
    tools,
    executors,
    userMessage,
    maxSteps = 12,
    maxAnswerChars = 500,
    allowImplicitText = true,
    traceRecorder,
    ephemeralSuffix,
  } = params

  // 没传 context 的简化路径:临时 in-memory context,把 userMessage 作为入口 user message。
  // 只有 tests 和老调用才走这分支;主回复路径必须传入持久 AgentContext。
  const context = params.context ?? createAgentContext()
  if (!params.context && userMessage != null) {
    await context.appendUserMessage({ role: 'user', content: userMessage })
  }

  const stepDetails: StepDetail[] = []
  const toolsCalled: string[] = []

  const finish = (result: AgentLoopResult, terminationReason: TraceTerminationReason): AgentLoopResult => {
    const totalDurationMs = Date.now() - startTime
    const tracedResult = traceRecorder
      ? {
          ...result,
          trace: traceRecorder.finish({
            finalState: result.state,
            finalAnswer: result.state === 'final' ? result.answer : undefined,
            terminationReason,
          }),
        }
      : result

    log.info(
      {
        state: tracedResult.state,
        termination: tracedResult.state === 'final'
          ? tracedResult.termination
          : ('reason' in tracedResult ? tracedResult.reason : undefined),
        steps: stepDetails.length,
        toolsCalled,
        totalDurationMs,
        stepDetails,
      },
      'agent_loop_complete',
    )
    return tracedResult
  }

  for (let step = 0; step < maxSteps; step++) {
    const stepStart = Date.now()
    const loopIndex = step + 1
    log.debug({ step }, 'agent_loop_step_start')
    traceRecorder?.loopStarted(loopIndex, `loop #${loopIndex} started`)

    const snapshot = await context.getSnapshot()
    const suffix = await resolveEphemeralSuffix(ephemeralSuffix, loopIndex)
    const { messages: history } = buildLlmRequest(snapshot, suffix)
    const turnResult = await chatFn({ systemPrompt, history, tools, loopIndex })

    if (turnResult.type === 'empty') {
      log.warn({ step }, 'agent_loop_empty_response')
      traceRecorder?.loopFinished({ phase: 'loop', loopIndex, summary: 'loop ended with empty response' })
      traceRecorder?.phaseStarted('finalize', 'finalize started')
      traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'empty response from model' })
      return finish({ state: 'fallback', reason: 'empty_response' }, 'empty_response')
    }

    const turnModel = 'model' in turnResult ? turnResult.model : undefined

    if (turnResult.type === 'text') {
      if (!allowImplicitText) {
        log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text_disallowed')
        traceRecorder?.think({
          phase: 'loop',
          loopIndex,
          summary: turnResult.content,
          raw: turnResult.content,
        })
        traceRecorder?.loopFinished({ phase: 'loop', loopIndex, summary: 'loop produced disallowed direct text answer' })
        traceRecorder?.phaseStarted('finalize', 'finalize started')
        traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'implicit text disallowed by policy' })
        return finish({ state: 'fallback', reason: 'implicit_text_disallowed' }, 'implicit_text')
      }
      log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text')
      stepDetails.push({ step, tool: '(text)', durationMs: Date.now() - stepStart, model: turnModel })
      traceRecorder?.think({
        phase: 'loop',
        loopIndex,
        summary: turnResult.content,
        raw: turnResult.content,
      })
      traceRecorder?.loopFinished({ phase: 'loop', loopIndex, summary: 'loop produced direct text answer' })
      traceRecorder?.phaseStarted('finalize', 'finalize started')
      traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'answer produced from text response' })
      return finish({ state: 'final', answer: turnResult.content, termination: 'implicit_text' }, 'implicit_text')
    }

    // type === 'tool_calls'
    if (turnResult.content?.trim()) {
      traceRecorder?.think({
        phase: 'loop',
        loopIndex,
        summary: turnResult.content.trim(),
        raw: turnResult.content.trim(),
      })
    }

    const calls = turnResult.calls

    // 保留旧短路语义:碰到 final_answer 就返回, 不执行其后的 calls。
    // 在 final_answer 之前的非控制 call 正常执行并写入 context。
    let finalAnswerCall: ToolCall | null = null
    const callsToRun: ToolCall[] = []
    for (const call of calls) {
      if (CONTROL_TOOL_NAMES.has(call.name)) {
        finalAnswerCall = call
        break
      }
      callsToRun.push(call)
    }

    // 普通 tool_calls / tool_results 入 context (跨轮可见)
    if (callsToRun.length > 0) {
      await context.appendToolCalls(callsToRun)
    }

    const results: ToolResult[] = []
    for (const call of callsToRun) {
      traceRecorder?.decision({
        phase: 'loop',
        loopIndex,
        summary: `calling tool ${call.name}`,
        raw: { callId: call.id, name: call.name, args: call.args },
      })
      traceRecorder?.toolCall({ callId: call.id, name: call.name, input: call.args, loopIndex })
      const executor = executors[call.name]
      if (!executor) {
        log.warn({ step, toolName: call.name }, 'agent_loop_unknown_tool')
        traceRecorder?.toolResult({
          callId: call.id,
          name: call.name,
          error: `Unknown tool: ${call.name}`,
          loopIndex,
        })
        results.push({ callId: call.id, name: call.name, output: '', error: `Unknown tool: ${call.name}` })
        continue
      }

      const toolStart = Date.now()
      try {
        const output = await executor(call.args)
        const durationMs = Date.now() - toolStart
        log.debug({ step, toolName: call.name, outputLen: output.length, durationMs }, 'agent_loop_tool_result')
        toolsCalled.push(call.name)
        stepDetails.push({ step, tool: call.name, durationMs, model: turnModel })
        traceRecorder?.toolResult({ callId: call.id, name: call.name, output, durationMs, loopIndex })
        results.push({ callId: call.id, name: call.name, output })
      } catch (err) {
        log.error({ step, toolName: call.name, error: err }, 'agent_loop_tool_error')
        toolsCalled.push(call.name)
        stepDetails.push({ step, tool: call.name, durationMs: Date.now() - toolStart, model: turnModel })
        const error = String(err)
        traceRecorder?.toolResult({ callId: call.id, name: call.name, error, durationMs: Date.now() - toolStart, loopIndex })
        results.push({ callId: call.id, name: call.name, output: '', error })
      }
    }

    if (results.length > 0) {
      await context.appendToolResults(results)
    }

    if (finalAnswerCall) {
      const answer = extractFinalAnswerText(finalAnswerCall, maxAnswerChars)
      toolsCalled.push('final_answer')
      stepDetails.push({ step, tool: 'final_answer', durationMs: Date.now() - stepStart, model: turnModel })
      traceRecorder?.decision({
        phase: 'finalize',
        summary: 'model requested final answer',
        raw: { callId: finalAnswerCall.id, args: finalAnswerCall.args },
      })
      traceRecorder?.loopFinished({ phase: 'loop', loopIndex, summary: 'loop ended with final answer request' })
      traceRecorder?.phaseStarted('finalize', 'finalize started')
      traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'final answer prepared', raw: { answer } })
      // 不写 context: 由调用方在发送成功后 appendAssistantTurn(model role)。
      return finish(
        { state: 'final', answer, termination: 'final_answer', finalAnswerPayload: finalAnswerCall.args },
        'final_answer',
      )
    }

    traceRecorder?.loopFinished({
      phase: 'loop',
      loopIndex,
      summary: `loop #${loopIndex} completed`,
      raw: { results },
    })
  }

  log.warn({ maxSteps }, 'agent_loop_max_steps_exceeded')
  traceRecorder?.phaseStarted('finalize', 'finalize started')
  traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'maximum loop count exceeded' })
  return finish({ state: 'aborted', reason: 'max_steps_exceeded' }, 'max_steps_exceeded')
}

async function resolveEphemeralSuffix(
  provider: EphemeralSuffixProvider | undefined,
  loopIndex: number,
): Promise<AgentMessage[]> {
  if (!provider) return []
  if (typeof provider === 'function') {
    const result = await provider(loopIndex)
    return result ?? []
  }
  return provider
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { warningTimeMs, maxTimeMs, ...rest } = params
  const startTime = Date.now()
  const slowWarningMs = warningTimeMs ?? maxTimeMs ?? 60_000
  const timer = setTimeout(() => {
    const totalDurationMs = Date.now() - startTime
    log.warn({ warningTimeMs: slowWarningMs, totalDurationMs }, 'agent_loop_slow_warning')
  }, slowWarningMs)
  timer.unref?.()

  try {
    return await executeLoop(rest as AgentLoopParams, startTime)
  } catch (err) {
    log.error({ error: err, totalDurationMs: Date.now() - startTime }, 'agent_loop_error')
    const runtimeError = String(err)
    params.traceRecorder?.phaseStarted('finalize', 'finalize started')
    params.traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'runtime error', raw: { error: runtimeError } })
    return params.traceRecorder
      ? {
          state: 'fallback',
          reason: runtimeError,
          trace: params.traceRecorder.finish({
            finalState: 'fallback',
            terminationReason: 'runtime_error',
          }),
        }
      : { state: 'fallback', reason: runtimeError }
  } finally {
    clearTimeout(timer)
  }
}
