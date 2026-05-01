import { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'
import { buildInputHash, type ContextFrame, type ContextFrameTokenUsage } from './context-frame.js'
import type { AgentMessage, AgentToolDeclaration, AgentTurnResult } from './types.js'

const log = createLogger('LLM_TRACE')

type ChatFn = (params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
  loopIndex?: number
}) => Promise<AgentTurnResult>

type CreateLlmTraceArgs = Parameters<typeof prisma.llmTrace.create>[0]
type CreateLlmTraceFn = (args: CreateLlmTraceArgs) => Promise<unknown>
let createLlmTrace: CreateLlmTraceFn = async (args) => prisma.llmTrace.create(args as Parameters<typeof prisma.llmTrace.create>[0])

export function setLlmTraceCreateForTest(fn: CreateLlmTraceFn): () => void {
  const previous = createLlmTrace
  createLlmTrace = fn
  return () => {
    createLlmTrace = previous
  }
}

export function recordLlmTrace(data: {
  groupId: number
  model: string | null
  input: { systemPrompt: string; history: AgentMessage[] }
  output: AgentTurnResult | null
  durationMs: number
  error?: string
  contextFrame?: ContextFrame
  loopIndex?: number
  inputHash?: string
  tokenUsage?: ContextFrameTokenUsage
}): void {
  const contextFrame = data.contextFrame
    ? {
        ...data.contextFrame,
        ...(data.tokenUsage?.rawUsage === undefined ? {} : { rawUsage: data.tokenUsage.rawUsage }),
      }
    : undefined

  createLlmTrace({
    data: {
      groupId: BigInt(data.groupId),
      model: data.model,
      input: data.input as Prisma.InputJsonValue,
      output: data.output !== null ? (data.output as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      durationMs: data.durationMs,
      error: data.error,
      frameId: data.contextFrame?.frameId,
      sceneId: data.contextFrame?.sceneId,
      opportunityId: data.contextFrame?.opportunityId,
      loopIndex: data.loopIndex,
      inputHash: data.inputHash,
      prefixHash: data.contextFrame?.prefixHash,
      tailHash: data.contextFrame?.tailHash,
      contextFrame: contextFrame ? contextFrame as Prisma.InputJsonValue : undefined,
      inputTokens: data.tokenUsage?.inputTokens,
      cachedTokens: data.tokenUsage?.cachedTokens,
      outputTokens: data.tokenUsage?.outputTokens,
      tokenUsageState: data.tokenUsage?.tokenUsageState,
    },
  } as CreateLlmTraceArgs)
    .catch((err: unknown) => {
      log.error({ error: err }, 'llm_trace_write_failed')
    })
}

export function withLlmTrace(chatFn: ChatFn, groupId: number, contextFrame?: ContextFrame): ChatFn {
  return async (params) => {
    const start = Date.now()
    const inputHash = buildInputHash(params)
    try {
      const result = await chatFn(params)
      recordLlmTrace({
        groupId,
        model: 'model' in result ? (result.model ?? null) : null,
        input: { systemPrompt: params.systemPrompt, history: params.history },
        output: result,
        durationMs: Date.now() - start,
        contextFrame,
        loopIndex: params.loopIndex,
        inputHash,
        tokenUsage: result.usage,
      })
      return result
    } catch (err) {
      recordLlmTrace({
        groupId,
        model: null,
        input: { systemPrompt: params.systemPrompt, history: params.history },
        output: null,
        durationMs: Date.now() - start,
        error: String(err),
        contextFrame,
        loopIndex: params.loopIndex,
        inputHash,
        tokenUsage: { inputTokens: null, cachedTokens: null, outputTokens: null, tokenUsageState: 'unknown' },
      })
      throw err
    }
  }
}
