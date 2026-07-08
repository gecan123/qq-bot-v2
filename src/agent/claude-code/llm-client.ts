/**
 * Claude Code identity 透传给 cliproxy 的 LlmClient 实现。
 *
 * cliproxy `cloak.mode=auto` 在客户端发完整 Claude Code identity payload
 * (UA `claude-cli/...` + Anthropic-Beta `claude-code-...` + 3-block system) 时
 * 不 cloak / 不替换 system prompt, 直接转发到 Anthropic, 复用 cliproxy 的 OAuth 池。
 *
 * 接口跟 src/agent/llm-client.ts 的 LlmClient 完全一致, 上层 BotLoopAgent 不感知路径。
 *
 * 不处理 401/403: token 在 cliproxy 端管理, bot 端只发 management apiKey。
 */
import { buildClaudeCodeHeaders } from './headers.js'
import { buildClaudeCodeRequestBody, type ClaudeToolChoice } from './request.js'
import {
  parseClaudeMessageResponse,
  type ClaudeMessageResponse,
} from './sse-parser.js'
import type { LlmClient, LlmCallInput, LlmCallOutput } from '../llm-client.js'
import type { AssistantToolCall, ClaudeAssistantNativeBlock } from '../agent-context.types.js'
import { recordCurrentTokenUsage } from '../../llm/token-usage.js'
import { createLogger } from '../../logger.js'
import {
  logClaudeThinkingBlocks,
  type ClaudeThinkingLogBlock,
  type ClaudeThinkingLogOptions,
} from './thinking-log.js'

const log = createLogger('claude-code-llm')

const HTTP_TIMEOUT_MS = 120_000

/**
 * 失败时附完整 native request/response payload, 让出问题时能直接在日志里看清出去的 system blocks /
 * tools / messages 与上游返回, 不需要手工 reproduce。
 *
 * pino logger 默认 err serializer 会展开 own enumerable 属性, 所以
 * `log.error({ err }, ...)` 自然会包含 status / requestBody / responseText 三块。
 */
export class ClaudeCodeApiError extends Error {
  readonly status: number | null
  readonly requestBody: unknown
  readonly responseText: string | null

  constructor(input: {
    message: string
    status: number | null
    requestBody: unknown
    responseText: string | null
    cause?: unknown
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined)
    this.name = 'ClaudeCodeApiError'
    this.status = input.status
    this.requestBody = input.requestBody
    this.responseText = input.responseText
  }
}

export interface CreateClaudeCodeLlmClientInput {
  model: string
  /** 已含 `/v1` 后缀, 例: `http://127.0.0.1:8317/v1`. endpoint 拼 `${baseURL}/messages?beta=true`. */
  baseURL: string
  /** cliproxy 自家 management key (`sk-local`)。 */
  apiKey: string
  /** Anthropic tool choice. 默认 any; 部分兼容 provider 仅正确支持 auto。 */
  toolChoice?: ClaudeToolChoice
  thinkingLog?: ClaudeThinkingLogOptions
}

export function createClaudeCodeLlmClient(input: CreateClaudeCodeLlmClientInput): LlmClient {
  const { model, baseURL, apiKey, toolChoice, thinkingLog } = input
  const url = `${baseURL}/messages?beta=true`

  return {
    async chat(req: LlmCallInput): Promise<LlmCallOutput> {
      // 注: req.temperature 这里被显式吃掉. Anthropic reasoning 模型拒收 temperature 字段
      // (见 request.ts 顶部注释), OpenAI 路径在 ../llm-client.ts 仍 honor 它。
      const body = buildClaudeCodeRequestBody({
        model,
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        tools: req.tools,
        toolChoice,
      })
      const bodyJson = JSON.stringify(body)

      const { response } = await callOnce({
        url,
        body: bodyJson,
        requestBody: body,
        accessToken: apiKey,
      })

      if (!response.ok) {
        throw new ClaudeCodeApiError({
          message: `Anthropic API ${response.status}`,
          status: response.status,
          requestBody: body,
          responseText: response.text,
        })
      }

      const parsed = parseClaudeMessageResponse(response.text)
      if (!parsed) {
        throw new ClaudeCodeApiError({
          message: 'Anthropic API 响应无法解析 (非合法 SSE / JSON)',
          status: response.status,
          requestBody: body,
          responseText: response.text,
        })
      }

      if (parsed.error) {
        const type = parsed.error.type ?? 'unknown_error'
        const message = parsed.error.message ?? 'unknown error'
        throw new ClaudeCodeApiError({
          message: `Anthropic API SSE error: ${type}: ${message}`,
          status: response.status,
          requestBody: body,
          responseText: response.text,
        })
      }

      // content:[] 是合法的 — 模型可以选择 end_turn 不输出任何 block。
      // 这种情况返回空 completion, BotLoop 会自然 skip 这一轮 (不 append assistant turn)。
      // 但仍然 warn 一下, 因为对 bot 来说 "既不调 wait 也不调 send_message" 是反常状态。
      if ((parsed.content?.length ?? 0) === 0) {
        log.warn(
          {
            status: response.status,
            usage: parsed.usage,
          },
          'anthropic_empty_completion',
        )
      }

      const output = toLlmCallOutput(parsed, model)
      void logClaudeThinkingBlocks({
        model: output.model,
        blocks: thinkingLogBlocks(parsed),
        toolCallIds: output.toolCalls.map((toolCall) => toolCall.id),
        options: thinkingLog,
      }).catch((err) => {
        log.warn({ err, model: output.model }, 'claude_thinking_log_unexpected_failure')
      })
      return output
    },
  }
}

interface CallOnceInput {
  url: string
  body: string
  /** 完整 request body 对象, 仅在 transport-level 失败时附进 ClaudeCodeApiError 用。 */
  requestBody: unknown
  accessToken: string
}

interface CallOnceOutput {
  response: { status: number; ok: boolean; text: string }
}

async function callOnce(input: CallOnceInput): Promise<CallOnceOutput> {
  const headers = buildClaudeCodeHeaders({
    accessToken: input.accessToken,
    timeoutMs: HTTP_TIMEOUT_MS,
  })
  let raw: Response
  try {
    raw = await fetch(input.url, {
      method: 'POST',
      headers,
      body: input.body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    throw new ClaudeCodeApiError({
      message: 'Anthropic API 调用失败 (transport)',
      status: null,
      requestBody: input.requestBody,
      responseText: null,
      cause: err,
    })
  }
  const text = await raw.text()
  return { response: { status: raw.status, ok: raw.ok, text } }
}

function toLlmCallOutput(parsed: ClaudeMessageResponse, fallbackModel: string): LlmCallOutput {
  const textParts: string[] = []
  const toolCalls: AssistantToolCall[] = []
  const nativeBlocks: ClaudeAssistantNativeBlock[] = []

  for (const block of parsed.content ?? []) {
    if (block.type === 'text') {
      if (block.text) textParts.push(block.text)
      continue
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      nativeBlocks.push({ ...block })
      continue
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      })
    }
  }

  const cacheRead = parsed.usage?.cache_read_input_tokens ?? null
  const cacheCreate = parsed.usage?.cache_creation_input_tokens ?? null
  const uncachedInput = parsed.usage?.input_tokens ?? null
  const inputTokens =
    uncachedInput == null && cacheRead == null && cacheCreate == null
      ? null
      : (uncachedInput ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0)
  const outputTokens = parsed.usage?.output_tokens ?? null

  if (inputTokens != null || outputTokens != null) {
    recordCurrentTokenUsage('agent.chat', {
      promptTokens: inputTokens ?? 0,
      completionTokens: outputTokens ?? 0,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    })
  }

  return {
    content: textParts.join('\n'),
    toolCalls,
    ...(nativeBlocks.length > 0 ? { nativeBlocks } : {}),
    usage: {
      inputTokens,
      cachedTokens: cacheRead,
      outputTokens,
    },
    model: parsed.model ?? fallbackModel,
  }
}

function thinkingLogBlocks(parsed: ClaudeMessageResponse): ClaudeThinkingLogBlock[] {
  return (parsed.content ?? []).flatMap((block, blockIndex) => {
    if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return []
    return [{ blockIndex, block: { ...block } }]
  })
}
