import { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'
import type { AgentMessage, AgentToolDeclaration, AgentTurnResult } from './types.js'

const log = createLogger('LLM_TRACE')

type ChatFn = (params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
}) => Promise<AgentTurnResult>

function recordLlmTrace(data: {
  groupId: number
  model: string | null
  input: { systemPrompt: string; history: AgentMessage[] }
  output: AgentTurnResult | null
  durationMs: number
  error?: string
}): void {
  prisma.llmTrace
    .create({
      data: {
        groupId: BigInt(data.groupId),
        model: data.model,
        input: data.input as Prisma.InputJsonValue,
        output: data.output !== null ? (data.output as Prisma.InputJsonValue) : Prisma.JsonNull,
        durationMs: data.durationMs,
        error: data.error,
      },
    })
    .catch((err: unknown) => {
      log.error({ error: err }, 'llm_trace_write_failed')
    })
}

export function withLlmTrace(chatFn: ChatFn, groupId: number): ChatFn {
  return async (params) => {
    const start = Date.now()
    try {
      const result = await chatFn(params)
      recordLlmTrace({
        groupId,
        model: 'model' in result ? (result.model ?? null) : null,
        input: { systemPrompt: params.systemPrompt, history: params.history },
        output: result,
        durationMs: Date.now() - start,
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
      })
      throw err
    }
  }
}
