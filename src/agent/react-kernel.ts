import type { AgentContext } from './agent-context.js'
import type { LlmCallOutput, LlmClient } from './llm-client.js'
import type { ToolContext, ToolEffect, ToolExecutionResult, ToolExecutor } from './tool.js'
import { recordTokenUsage } from './token-stats.js'
import { createLogger } from '../logger.js'
import {
  buildWorkingContextProjection,
  type WorkingContextOptions,
} from './working-context.js'
import { isParallelSafeToolCall } from './tool-concurrency.js'

const log = createLogger('REACT_KERNEL')

export interface ReactRoundInput {
  systemPrompt: string
  context: AgentContext
  llm: LlmClient
  tools: ToolExecutor
  toolContext: ToolContext
  workingContext?: WorkingContextOptions
  signal?: AbortSignal
}

export interface ReactToolEffect {
  toolCallId: string
  toolName: string
  effect: ToolEffect
}

export interface ReactToolOutcome {
  toolCallId: string
  requestedToolName: string
  toolName: string
  ok: boolean
  code?: string
}

export interface ReactRoundResult {
  inputTokens: number | null
  tokensUsed: number
  toolCallCount: number
  effects: ReactToolEffect[]
  /** 仅供当前 Runtime Host 决定纠错/等待，不进入 AgentContext。 */
  toolOutcomes: ReactToolOutcome[]
}

const DEFAULT_ESCALATED_OUTPUT_TOKENS = 8_192
const MAX_ESCALATED_OUTPUT_TOKENS = 65_536

/**
 * max_tokens 命中后的有界失败。completion 只用于安全续写，里面的 tool call 尚未执行，
 * 也尚未写入 AgentContext。
 */
export class LlmOutputTruncatedError extends Error {
  readonly completion: LlmCallOutput
  readonly tokensUsed: number

  constructor(completion: LlmCallOutput, tokensUsed: number) {
    super('LLM output remained truncated after one max-output escalation')
    this.name = 'LlmOutputTruncatedError'
    this.completion = completion
    this.tokensUsed = tokensUsed
  }
}

class LlmContextWindowStopError extends Error {
  readonly kind = 'context_overflow'

  constructor() {
    super('LLM stopped because the model context window was exhausted')
    this.name = 'LlmContextWindowStopError'
  }
}

export async function runReactRound(input: ReactRoundInput): Promise<ReactRoundResult> {
  const roundIndex = input.toolContext.roundIndex
  const snapshot = input.context.getSnapshot()
  const workingContext = buildWorkingContextProjection(snapshot.messages, input.workingContext)
  const visibleTools = input.tools.list()

  if (workingContext.stats.omittedImages > 0) {
    log.info(
      { roundIndex, ...workingContext.stats },
      'working_context_projected',
    )
  }

  const completions: LlmCallOutput[] = []
  let maxOutputTokens: number | undefined
  let didEscalateOutputBudget = false
  let completion: LlmCallOutput

  while (true) {
    completion = await input.llm.chat({
      systemPrompt: input.systemPrompt,
      messages: workingContext.messages,
      tools: visibleTools,
      signal: input.signal,
      ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
    })
    completions.push(completion)
    recordCompletion(roundIndex, completion)

    if (completion.stopReason === 'model_context_window_exceeded') {
      throw new LlmContextWindowStopError()
    }
    if (completion.stopReason !== 'max_tokens') break

    if (didEscalateOutputBudget) {
      throw new LlmOutputTruncatedError(completion, sumTokensUsed(completions))
    }
    const escalated = resolveEscalatedOutputTokens(maxOutputTokens, completion.usage.outputTokens)
    maxOutputTokens = escalated
    didEscalateOutputBudget = true
    log.warn(
      {
        roundIndex,
        previousOutputTokens: completion.usage.outputTokens,
        maxOutputTokens,
      },
      'round_output_truncated_retrying_with_larger_budget',
    )
  }

  log.info(
    {
      roundIndex,
      toolCallCount: completion.toolCalls.length,
      toolNames: completion.toolCalls.map((c) => c.name),
      effectiveToolNames: completion.toolCalls.map(resolveEffectiveToolName),
      contentLen: completion.content.length,
      inputTokens: completion.usage.inputTokens,
      cachedTokens: completion.usage.cachedTokens,
      outputTokens: completion.usage.outputTokens,
      model: completion.model,
      stopReason: completion.stopReason ?? 'unknown',
    },
    'round_llm_done',
  )

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
      ...(completion.nativeBlocks ? { nativeBlocks: completion.nativeBlocks } : {}),
    })
  }

  const effects: ReactToolEffect[] = []
  const toolOutcomes: ReactToolOutcome[] = []
  let cursor = 0
  while (cursor < completion.toolCalls.length) {
    const call = completion.toolCalls[cursor]!
    const batch = isParallelSafeToolCall(call)
      ? takeParallelSafeBatch(completion.toolCalls, cursor)
      : [call]
    if (batch.length > 1) {
      log.info(
        { roundIndex, toolNames: batch.map((item) => item.name), batchSize: batch.length },
        'parallel_read_only_tool_batch_started',
      )
    }
    const results = batch.length > 1
      ? await Promise.all(batch.map((item) => executeToolCall(input.tools, item, input.toolContext)))
      : [await executeToolCall(input.tools, batch[0]!, input.toolContext)]

    for (let index = 0; index < batch.length; index++) {
      const batchCall = batch[index]!
      const result = results[index]!
      for (const effect of result.effects ?? []) {
        effects.push({
          toolCallId: batchCall.id,
          toolName: resolveEffectiveToolName(batchCall),
          effect,
        })
      }
      toolOutcomes.push({
        toolCallId: batchCall.id,
        requestedToolName: batchCall.name,
        toolName: resolveEffectiveToolName(batchCall),
        ok: result.outcome?.ok ?? true,
        ...(result.outcome?.code ? { code: result.outcome.code } : {}),
      })
      log.info({
        roundIndex,
        requestedToolName: batchCall.name,
        toolName: resolveEffectiveToolName(batchCall),
        ok: result.outcome?.ok ?? true,
        code: result.outcome?.code,
      }, 'round_tool_done')
      input.context.appendToolResult({ toolCallId: batchCall.id, content: result.content })
    }
    cursor += batch.length
  }

  return {
    inputTokens: completion.usage.inputTokens,
    tokensUsed: sumTokensUsed(completions),
    toolCallCount: completion.toolCalls.length,
    effects,
    toolOutcomes,
  }
}

function takeParallelSafeBatch(
  calls: readonly Parameters<ToolExecutor['execute']>[0][],
  start: number,
): Parameters<ToolExecutor['execute']>[0][] {
  const batch: Parameters<ToolExecutor['execute']>[0][] = []
  for (let index = start; index < calls.length; index++) {
    const call = calls[index]!
    if (!isParallelSafeToolCall(call)) break
    batch.push(call)
  }
  return batch
}

function recordCompletion(roundIndex: number, completion: LlmCallOutput): void {
  recordTokenUsage({
    operation: 'agent.chat',
    roundIndex,
    inputTokens: completion.usage.inputTokens,
    cachedTokens: completion.usage.cachedTokens,
    outputTokens: completion.usage.outputTokens,
    model: completion.model,
  })
}

/**
 * invoke 是 deferred capability 的稳定壳；运维统计更关心它实际请求的内部工具。
 * 参数不完整时保留 invoke，日报会把它标成 unresolved 而不是猜测。
 */
export function resolveEffectiveToolName(call: LlmCallOutput['toolCalls'][number]): string {
  if (call.name !== 'invoke') return call.name
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return call.name
  const target = (call.args as Record<string, unknown>).tool
  return typeof target === 'string' && target.trim().length > 0 ? target : call.name
}

function sumTokensUsed(completions: readonly LlmCallOutput[]): number {
  return completions.reduce(
    (sum, completion) => sum
      + Math.max(
        0,
        (completion.usage.inputTokens ?? 0) - (completion.usage.cachedTokens ?? 0),
      )
      + (completion.usage.outputTokens ?? 0),
    0,
  )
}

function resolveEscalatedOutputTokens(
  current: number | undefined,
  observedOutputTokens: number | null,
): number {
  const candidate = Math.max(
    DEFAULT_ESCALATED_OUTPUT_TOKENS,
    (current ?? 0) * 2,
    (observedOutputTokens ?? 0) * 2,
  )
  return Math.min(MAX_ESCALATED_OUTPUT_TOKENS, Math.max(1, Math.ceil(candidate)))
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
