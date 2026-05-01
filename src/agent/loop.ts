import type { AgentLoopResult, AgentMessage, AgentToolDeclaration, AgentTurnResult, ToolResult } from './types.js'
import type { ToolExecutor } from './tools.js'
import type { TraceRecorder, TraceTerminationReason } from './trace.js'
import { createLogger } from '../logger.js'

type ChatFn = (params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
  loopIndex?: number
}) => Promise<AgentTurnResult>

const log = createLogger('AGENT')

export interface AgentLoopParams {
  systemPrompt: string
  /** 直接指定初始 history（多轮 context injection 场景）。与 userMessage 二选一。 */
  initialHistory?: AgentMessage[]
  /** 单条用户消息，作为 initialHistory 的简写。initialHistory 优先。 */
  userMessage?: string
  chatFn: ChatFn
  tools: AgentToolDeclaration[]
  executors: Record<string, ToolExecutor>
  maxSteps?: number
  allowImplicitText?: boolean
  /** 慢请求告警阈值（毫秒），仅告警不中断 */
  warningTimeMs?: number
  /** @deprecated 保留兼容；等价于 warningTimeMs */
  maxTimeMs?: number
  maxAnswerChars?: number
  traceRecorder?: TraceRecorder
}

interface StepDetail {
  step: number
  tool: string
  durationMs: number
  model?: string
}

async function executeLoop(params: AgentLoopParams, startTime: number): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    initialHistory,
    userMessage,
    chatFn,
    tools,
    executors,
    maxSteps = 12,
    maxAnswerChars = 500,
    allowImplicitText = true,
    traceRecorder,
  } = params

  const history: AgentMessage[] = initialHistory ?? [{ role: 'user', content: userMessage ?? '' }]
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
    history.push({ role: 'tool_calls', calls })

    const results: ToolResult[] = []

    for (const call of calls) {
      if (call.name === 'final_answer') {
        const replyText =
          (call.args['replyText'] as string | undefined) ??
          (call.args['text'] as string | undefined) ??
          ''
        const answer = replyText.slice(0, maxAnswerChars)
        toolsCalled.push('final_answer')
        stepDetails.push({ step, tool: 'final_answer', durationMs: Date.now() - stepStart, model: turnModel })
        traceRecorder?.decision({
          phase: 'finalize',
          summary: 'model requested final answer',
          raw: { callId: call.id, args: call.args },
        })
        traceRecorder?.loopFinished({ phase: 'loop', loopIndex, summary: 'loop ended with final answer request' })
        traceRecorder?.phaseStarted('finalize', 'finalize started')
        traceRecorder?.phaseFinished({ phase: 'finalize', summary: 'final answer prepared', raw: { answer } })
        return finish(
          { state: 'final', answer, termination: 'final_answer', finalAnswerPayload: call.args },
          'final_answer',
        )
      }

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

    history.push({ role: 'tool_results', results })
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
