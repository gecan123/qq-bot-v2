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
  maxTimeMs?: number
  maxAnswerChars?: number
}

interface StepDetail {
  step: number
  tool: string
  durationMs: number
}

async function executeLoop(params: AgentLoopParams, startTime: number): Promise<AgentLoopResult> {
  const { systemPrompt, userMessage, adapter, tools, executors, maxSteps = 8, maxAnswerChars = 500 } = params

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

    if (turnResult.type === 'text') {
      log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text')
      stepDetails.push({ step, tool: '(text)', durationMs: Date.now() - stepStart })
      return finish({ state: 'final', answer: turnResult.content, termination: 'implicit_text' })
    }

    // type === 'tool_calls'
    const calls = turnResult.calls
    history.push({ role: 'tool_calls', calls })

    const results: ToolResult[] = []

    for (const call of calls) {
      if (call.name === 'final_answer') {
        const text = (call.args['text'] as string | undefined) ?? ''
        const answer = text.slice(0, maxAnswerChars)
        toolsCalled.push('final_answer')
        stepDetails.push({ step, tool: 'final_answer', durationMs: Date.now() - stepStart })
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
        stepDetails.push({ step, tool: call.name, durationMs })
        results.push({ callId: call.id, name: call.name, output })
      } catch (err) {
        log.error({ step, toolName: call.name, error: err }, 'agent_loop_tool_error')
        toolsCalled.push(call.name)
        stepDetails.push({ step, tool: call.name, durationMs: Date.now() - toolStart })
        results.push({ callId: call.id, name: call.name, output: '', error: String(err) })
      }
    }

    history.push({ role: 'tool_results', results })
  }

  log.warn({ maxSteps }, 'agent_loop_max_steps_exceeded')
  return finish({ state: 'aborted', reason: 'max_steps_exceeded' })
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { maxTimeMs = 30_000, ...rest } = params
  const startTime = Date.now()

  const timeoutPromise = new Promise<AgentLoopResult>((resolve) => {
    const timer = setTimeout(() => {
      const totalDurationMs = Date.now() - startTime
      log.warn({ maxTimeMs, totalDurationMs }, 'agent_loop_timeout')
      resolve({ state: 'fallback', reason: 'timeout' })
    }, maxTimeMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([executeLoop(rest, startTime), timeoutPromise])
  } catch (err) {
    log.error({ error: err, totalDurationMs: Date.now() - startTime }, 'agent_loop_error')
    return { state: 'fallback', reason: String(err) }
  }
}
