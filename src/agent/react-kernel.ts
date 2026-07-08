import type { AgentContext } from './agent-context.js'
import type { LlmClient } from './llm-client.js'
import type { ToolControl, ToolContext, ToolExecutionResult, ToolExecutor } from './tool.js'
import { recordTokenUsage } from './token-stats.js'
import { createLogger } from '../logger.js'

const log = createLogger('REACT_KERNEL')

export interface ReactRoundInput {
  systemPrompt: string
  context: AgentContext
  llm: LlmClient
  tools: ToolExecutor
  toolContext: ToolContext
}

export interface ReactToolControl {
  toolCallId: string
  toolName: string
  control: ToolControl
}

export interface ReactRoundResult {
  inputTokens: number | null
  tokensUsed: number
  controls: ReactToolControl[]
}

export async function runReactRound(input: ReactRoundInput): Promise<ReactRoundResult> {
  const roundIndex = input.toolContext.roundIndex
  const snapshot = input.context.getSnapshot()
  const visibleTools = input.tools.list()

  const completion = await input.llm.chat({
    systemPrompt: input.systemPrompt,
    messages: snapshot.messages,
    tools: visibleTools,
  })

  log.info(
    {
      roundIndex,
      toolCallCount: completion.toolCalls.length,
      toolNames: completion.toolCalls.map((c) => c.name),
      contentLen: completion.content.length,
      inputTokens: completion.usage.inputTokens,
      cachedTokens: completion.usage.cachedTokens,
      outputTokens: completion.usage.outputTokens,
      model: completion.model,
    },
    'round_llm_done',
  )

  recordTokenUsage({
    operation: 'agent.chat',
    roundIndex,
    inputTokens: completion.usage.inputTokens,
    cachedTokens: completion.usage.cachedTokens,
    outputTokens: completion.usage.outputTokens,
    model: completion.model,
  })

  if (completion.content.length > 0) {
    log.warn(
      {
        roundIndex,
        contentLen: completion.content.length,
        toolCallCount: completion.toolCalls.length,
      },
      'assistant_text_dropped_from_context',
    )
  }

  if (completion.toolCalls.length > 0) {
    input.context.appendAssistantTurn({
      content: '',
      toolCalls: completion.toolCalls,
    })
  }

  const controls: ReactToolControl[] = []
  for (const call of completion.toolCalls) {
    const result = await executeToolCall(input.tools, call, input.toolContext)
    if (result.control) {
      controls.push({
        toolCallId: call.id,
        toolName: call.name,
        control: result.control,
      })
    }
    input.context.appendToolResult({ toolCallId: call.id, content: result.content })
  }

  return {
    inputTokens: completion.usage.inputTokens,
    tokensUsed: (completion.usage.inputTokens ?? 0) + (completion.usage.outputTokens ?? 0),
    controls,
  }
}

async function executeToolCall(
  tools: ToolExecutor,
  call: Parameters<ToolExecutor['execute']>[0],
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    return await tools.execute(call, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: JSON.stringify({
        ok: false,
        code: 'execution_failed',
        error: `Tool execution failed: ${message}`,
      }),
    }
  }
}
