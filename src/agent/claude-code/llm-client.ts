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
import {
  buildClaudeCodeRequestBody,
  type ClaudeThinkingConfig,
  type ClaudeToolChoice,
} from './request.js'
import {
  parseClaudeMessageResponse,
  type ClaudeMessageResponse,
} from './sse-parser.js'
import type {
  LlmClient,
  LlmCallInput,
  LlmCallOutput,
  LlmStopReason,
} from '../llm-client.js'
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
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000

export type ClaudeCodeErrorKind =
  | 'transport'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'auth'
  | 'permission'
  | 'context_overflow'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_error'
  | 'http'

export interface ClaudeRetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

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
  readonly kind: ClaudeCodeErrorKind
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly requestId: string | null
  readonly providerErrorType: string | null

  constructor(input: {
    message: string
    status: number | null
    requestBody: unknown
    responseText: string | null
    kind: ClaudeCodeErrorKind
    retryable?: boolean
    retryAfterMs?: number | null
    requestId?: string | null
    providerErrorType?: string | null
    cause?: unknown
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined)
    this.name = 'ClaudeCodeApiError'
    this.status = input.status
    this.requestBody = input.requestBody
    this.responseText = input.responseText
    this.kind = input.kind
    this.retryable = input.retryable ?? false
    this.retryAfterMs = input.retryAfterMs ?? null
    this.requestId = input.requestId ?? null
    this.providerErrorType = input.providerErrorType ?? null
  }
}

export interface CreateClaudeCodeLlmClientInput {
  model: string
  contextWindowTokens: number
  /** 已含 `/v1` 后缀, 例: `http://127.0.0.1:8317/v1`. endpoint 拼 `${baseURL}/messages?beta=true`. */
  baseURL: string
  /** cliproxy 自家 management key (`sk-local`)。 */
  apiKey: string
  /** Anthropic tool choice. 默认 any; 部分兼容 provider 仅正确支持 auto。 */
  toolChoice?: ClaudeToolChoice
  thinking?: ClaudeThinkingConfig
  thinkingLog?: ClaudeThinkingLogOptions
  retry?: ClaudeRetryOptions
}

export function createClaudeCodeLlmClient(input: CreateClaudeCodeLlmClientInput): LlmClient {
  const { model, contextWindowTokens, baseURL, apiKey, toolChoice, thinking, thinkingLog } = input
  const url = `${baseURL}/messages?beta=true`
  const retry = normalizeRetryOptions(input.retry)

  return {
    async chat(req: LlmCallInput): Promise<LlmCallOutput> {
      // 注: req.temperature 这里被显式吃掉. Anthropic reasoning 模型拒收 temperature 字段
      // (见 request.ts 顶部注释), OpenAI 路径在 ../llm-client.ts 仍 honor 它。
      const body = buildClaudeCodeRequestBody({
        model,
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        tools: req.tools,
        maxOutputTokens: req.maxOutputTokens,
        toolChoice,
        thinking,
      })
      const bodyJson = JSON.stringify(body)

      const { parsed, status } = await callWithRetry({
        url,
        body: bodyJson,
        requestBody: body,
        accessToken: apiKey,
        signal: req.signal,
        retry,
      })

      // content:[] 是合法的 — 模型可以选择 end_turn 不输出任何 block。
      // 这种情况返回空 completion, BotLoop 会自然 skip 这一轮 (不 append assistant turn)。
      // 但仍然 warn 一下, 因为对 bot 来说 "既不调 wait 也不调 send_message" 是反常状态。
      if ((parsed.content?.length ?? 0) === 0) {
        log.warn(
          {
            status,
            usage: parsed.usage,
          },
          'anthropic_empty_completion',
        )
      }

      const output = toLlmCallOutput(parsed, model, contextWindowTokens)
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
  signal?: AbortSignal
}

interface CallOnceOutput {
  response: {
    status: number
    ok: boolean
    text: string
    retryAfter: string | null
    requestId: string | null
  }
}

interface NormalizedRetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  random: () => number
}

async function callWithRetry(
  input: CallOnceInput & { retry: NormalizedRetryOptions },
): Promise<{ parsed: ClaudeMessageResponse; status: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { response } = await callOnce(input)
      if (!response.ok) throw httpError(input.requestBody, response)

      const parsed = parseClaudeMessageResponse(response.text)
      if (!parsed) {
        throw new ClaudeCodeApiError({
          message: 'Anthropic API 响应无法解析 (非合法 SSE / JSON)',
          status: response.status,
          requestBody: input.requestBody,
          responseText: response.text,
          requestId: response.requestId,
          kind: 'invalid_response',
        })
      }

      if (parsed.error) {
        const providerErrorType = parsed.error.type ?? 'unknown_error'
        const message = parsed.error.message ?? 'unknown error'
        const classification = classifyProviderError(providerErrorType, message)
        throw new ClaudeCodeApiError({
          message: `Anthropic API SSE error: ${providerErrorType}: ${message}`,
          status: response.status,
          requestBody: input.requestBody,
          responseText: response.text,
          requestId: response.requestId,
          providerErrorType,
          ...classification,
        })
      }

      return { parsed, status: response.status }
    } catch (err) {
      if (input.signal?.aborted) throw err
      if (!(err instanceof ClaudeCodeApiError) || !err.retryable || attempt >= input.retry.maxRetries) {
        throw err
      }

      const delayMs = calculateRetryDelayMs({
        attempt,
        retryAfterMs: err.retryAfterMs,
        baseDelayMs: input.retry.baseDelayMs,
        maxDelayMs: input.retry.maxDelayMs,
        random: input.retry.random,
      })

      log.warn(
        {
          error: err.message,
          kind: err.kind,
          status: err.status,
          providerErrorType: err.providerErrorType,
          requestId: err.requestId,
          cause: err.cause instanceof Error ? err.cause.message : undefined,
          attempt: attempt + 1,
          maxRetries: input.retry.maxRetries,
          delayMs,
        },
        'claude_request_retry',
      )
      await input.retry.sleep(delayMs, input.signal)
    }
  }
}

async function callOnce(input: CallOnceInput): Promise<CallOnceOutput> {
  const headers = buildClaudeCodeHeaders({
    accessToken: input.accessToken,
    timeoutMs: HTTP_TIMEOUT_MS,
  })
  try {
    const httpTimeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS)
    const signal = input.signal
      ? AbortSignal.any([input.signal, httpTimeoutSignal])
      : httpTimeoutSignal
    const raw = await fetch(input.url, {
      method: 'POST',
      headers,
      body: input.body,
      signal,
    })
    const text = await raw.text()
    return {
      response: {
        status: raw.status,
        ok: raw.ok,
        text,
        retryAfter: raw.headers.get('retry-after'),
        requestId: raw.headers.get('request-id'),
      },
    }
  } catch (err) {
    throw new ClaudeCodeApiError({
      message: 'Anthropic API 调用失败 (transport)',
      status: null,
      requestBody: input.requestBody,
      responseText: null,
      kind: 'transport',
      retryable: true,
      cause: err,
    })
  }
}

function httpError(
  requestBody: unknown,
  response: CallOnceOutput['response'],
): ClaudeCodeApiError {
  const provider = parseProviderError(response.text)
  const classification = classifyHttpStatus(
    response.status,
    provider?.type ?? null,
    provider?.message ?? null,
  )
  return new ClaudeCodeApiError({
    message: `Anthropic API ${response.status}`,
    status: response.status,
    requestBody,
    responseText: response.text,
    retryAfterMs: parseRetryAfterMs(response.retryAfter),
    requestId: response.requestId,
    providerErrorType: provider?.type ?? null,
    ...classification,
  })
}

function parseProviderError(raw: string): { type?: string; message?: string } | null {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown }
    if (!parsed.error || typeof parsed.error !== 'object') return null
    const error = parsed.error as Record<string, unknown>
    return {
      ...(typeof error.type === 'string' ? { type: error.type } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
    }
  } catch {
    return null
  }
}

function classifyHttpStatus(
  status: number,
  providerType: string | null,
  providerMessage: string | null,
): { kind: ClaudeCodeErrorKind; retryable: boolean } {
  if (isContextOverflow(providerType, providerMessage)) {
    return { kind: 'context_overflow', retryable: false }
  }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status === 529) return { kind: 'overloaded', retryable: true }
  if (status >= 500 && status <= 599) return { kind: 'server', retryable: true }
  if (status === 401) return { kind: 'auth', retryable: false }
  if (status === 403) return { kind: 'permission', retryable: false }
  if (status === 400 || status === 413) return { kind: 'invalid_request', retryable: false }
  return { kind: 'http', retryable: false }
}

function classifyProviderError(
  type: string,
  message: string,
): { kind: ClaudeCodeErrorKind; retryable: boolean } {
  if (isContextOverflow(type, message)) return { kind: 'context_overflow', retryable: false }
  if (type === 'rate_limit_error') return { kind: 'rate_limit', retryable: true }
  if (type === 'overloaded_error') return { kind: 'overloaded', retryable: true }
  if (type === 'api_error' || type === 'timeout_error') return { kind: 'server', retryable: true }
  if (type === 'authentication_error') return { kind: 'auth', retryable: false }
  if (type === 'permission_error') return { kind: 'permission', retryable: false }
  if (type === 'invalid_request_error' || type === 'request_too_large') {
    return { kind: 'invalid_request', retryable: false }
  }
  return { kind: 'provider_error', retryable: false }
}

function isContextOverflow(type: string | null, message: string | null): boolean {
  if (type === 'context_length_exceeded' || type === 'prompt_too_long') return true
  if (!message) return false
  return [
    /prompt is too long/i,
    /(?:context length|context window).*(?:exceed|maximum|limit|too long)/i,
    /input.*(?:too long|too many tokens|token limit|maximum)/i,
    /too many (?:input )?tokens/i,
  ].some((pattern) => pattern.test(message))
}

function normalizeRetryOptions(options: ClaudeRetryOptions = {}): NormalizedRetryOptions {
  return {
    maxRetries: Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)),
    baseDelayMs: Math.max(0, Math.floor(options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS)),
    maxDelayMs: Math.max(0, Math.floor(options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS)),
    sleep: options.sleep ?? sleepWithSignal,
    random: options.random ?? Math.random,
  }
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - nowMs)
}

export function calculateRetryDelayMs(input: {
  attempt: number
  retryAfterMs: number | null
  baseDelayMs: number
  maxDelayMs: number
  random: () => number
}): number {
  if (input.retryAfterMs != null) return Math.min(input.maxDelayMs, input.retryAfterMs)
  const exponential = Math.min(input.maxDelayMs, input.baseDelayMs * (2 ** input.attempt))
  const jitter = 0.8 + Math.min(1, Math.max(0, input.random())) * 0.4
  return Math.min(input.maxDelayMs, Math.max(0, Math.round(exponential * jitter)))
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function toLlmCallOutput(
  parsed: ClaudeMessageResponse,
  fallbackModel: string,
  contextWindowTokens: number,
): LlmCallOutput {
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
    contextWindowTokens,
    stopReason: normalizeClaudeStopReason(parsed.stop_reason),
  }
}

function normalizeClaudeStopReason(value: string | null | undefined): LlmStopReason {
  switch (value) {
    case 'tool_use':
    case 'end_turn':
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
      return value
    default:
      return 'unknown'
  }
}

function thinkingLogBlocks(parsed: ClaudeMessageResponse): ClaudeThinkingLogBlock[] {
  return (parsed.content ?? []).flatMap((block, blockIndex) => {
    if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return []
    return [{ blockIndex, block: { ...block } }]
  })
}
