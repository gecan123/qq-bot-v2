import type { AgentLlmAdapter, AgentLoopResult, AgentMessage, AgentToolDeclaration, ToolResult } from './types.js'
import type { ToolExecutor } from './tools.js'
import { log } from '../logger.js'

export interface AgentLoopParams {
  systemPrompt: string
  userMessage: string
  adapter: AgentLlmAdapter
  tools: AgentToolDeclaration[]
  executors: Record<string, ToolExecutor>
  maxSteps?: number
  /** 慢请求告警阈值（毫秒），仅告警不中断 */
  warningTimeMs?: number
  /** @deprecated 保留兼容；等价于 warningTimeMs */
  maxTimeMs?: number
  maxAnswerChars?: number
}

interface StepDetail {
  step: number
  tool: string
  durationMs: number
  model?: string
}

async function executeLoop(params: AgentLoopParams, startTime: number): Promise<AgentLoopResult> {
  const { systemPrompt, userMessage, adapter, tools, executors, maxSteps = 12, maxAnswerChars = 500 } = params

  const history: AgentMessage[] = [{ role: 'user', content: userMessage }]
  const stepDetails: StepDetail[] = []
  const toolsCalled: string[] = []

  const finish = (result: AgentLoopResult): AgentLoopResult => {
    const totalDurationMs = Date.now() - startTime
    log.info(
      {
        state: result.state,
        termination: result.state === 'final' ? result.termination : ('reason' in result ? result.reason : undefined),
        steps: stepDetails.length,
        toolsCalled,
        totalDurationMs,
        stepDetails,
      },
      'agent_loop_complete',
    )
    return result
  }

  for (let step = 0; step < maxSteps; step++) {
    const stepStart = Date.now()
    log.debug({ step }, 'agent_loop_step_start')

    const turnResult = await adapter.chat({ systemPrompt, history, tools })

    if (turnResult.type === 'empty') {
      log.warn({ step }, 'agent_loop_empty_response')
      return finish({ state: 'fallback', reason: 'empty_response' })
    }

    const turnModel = 'model' in turnResult ? turnResult.model : undefined

    if (turnResult.type === 'text') {
      log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text')
      stepDetails.push({ step, tool: '(text)', durationMs: Date.now() - stepStart, model: turnModel })
      return finish({ state: 'final', answer: turnResult.content, termination: 'implicit_text' })
    }

    // type === 'tool_calls'
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
        return finish({ state: 'final', answer, termination: 'final_answer' })
      }

      const executor = executors[call.name]
      if (!executor) {
        log.warn({ step, toolName: call.name }, 'agent_loop_unknown_tool')
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
        results.push({ callId: call.id, name: call.name, output })
      } catch (err) {
        log.error({ step, toolName: call.name, error: err }, 'agent_loop_tool_error')
        toolsCalled.push(call.name)
        stepDetails.push({ step, tool: call.name, durationMs: Date.now() - toolStart, model: turnModel })
        results.push({ callId: call.id, name: call.name, output: '', error: String(err) })
      }
    }

    history.push({ role: 'tool_results', results })
  }

  log.warn({ maxSteps }, 'agent_loop_max_steps_exceeded')
  return finish({ state: 'aborted', reason: 'max_steps_exceeded' })
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
    return { state: 'fallback', reason: String(err) }
  } finally {
    clearTimeout(timer)
  }
}
