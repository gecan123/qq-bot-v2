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
}

async function executeLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { systemPrompt, userMessage, adapter, tools, executors, maxSteps = 4 } = params

  const history: AgentMessage[] = [{ role: 'user', content: userMessage }]

  for (let step = 0; step < maxSteps; step++) {
    log.debug({ step }, 'agent_loop_step_start')

    const turnResult = await adapter.chat({ systemPrompt, history, tools })

    if (turnResult.type === 'empty') {
      log.warn({ step }, 'agent_loop_empty_response')
      return { state: 'fallback', reason: 'empty_response' }
    }

    if (turnResult.type === 'text') {
      log.warn({ step, content: turnResult.content.slice(0, 50) }, 'agent_loop_implicit_text')
      return { state: 'final', answer: turnResult.content, termination: 'implicit_text' }
    }

    // type === 'tool_calls'
    const calls = turnResult.calls
    history.push({ role: 'tool_calls', calls })

    const results: ToolResult[] = []

    for (const call of calls) {
      if (call.name === 'final_answer') {
        const text = (call.args['text'] as string | undefined) ?? ''
        const answer = text.slice(0, 500)
        log.info({ step, answer: answer.slice(0, 50) }, 'agent_loop_complete')
        return { state: 'final', answer, termination: 'final_answer' }
      }

      const executor = executors[call.name]
      if (!executor) {
        log.warn({ step, toolName: call.name }, 'agent_loop_unknown_tool')
        results.push({
          callId: call.id,
          name: call.name,
          output: '',
          error: `Unknown tool: ${call.name}`,
        })
        continue
      }

      try {
        const output = await executor(call.args)
        log.debug({ step, toolName: call.name, outputLen: output.length }, 'agent_loop_tool_result')
        results.push({ callId: call.id, name: call.name, output })
      } catch (err) {
        log.error({ step, toolName: call.name, error: err }, 'agent_loop_tool_error')
        results.push({ callId: call.id, name: call.name, output: '', error: String(err) })
      }
    }

    history.push({ role: 'tool_results', results })
  }

  log.warn({ maxSteps }, 'agent_loop_max_steps_exceeded')
  return { state: 'aborted', reason: 'max_steps_exceeded' }
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { maxTimeMs = 30_000, ...rest } = params

  const timeoutPromise = new Promise<AgentLoopResult>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ maxTimeMs }, 'agent_loop_timeout')
      resolve({ state: 'fallback', reason: 'timeout' })
    }, maxTimeMs)
    // Allow process to exit if only this timer remains
    timer.unref?.()
  })

  try {
    return await Promise.race([executeLoop(rest), timeoutPromise])
  } catch (err) {
    log.error({ error: err }, 'agent_loop_error')
    return { state: 'fallback', reason: String(err) }
  }
}
