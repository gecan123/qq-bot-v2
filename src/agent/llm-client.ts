import type { AgentMessage } from './agent-context.types.js'
import type { Tool } from './tool.js'
import type { AssistantToolCall, ClaudeAssistantNativeBlock } from './agent-context.types.js'
import {
  CLAUDE_CODE_BASE_PROVIDER_NAME,
  CLAUDE_CODE_PROVIDER_NAME,
  config,
  OPENAI_AGENT_BASE_PROVIDER_NAME,
  OPENAI_AGENT_PROVIDER_NAME,
} from '../config/index.js'
import { createClaudeCodeLlmClient } from './claude-code/llm-client.js'
import { createOpenAIAgentLlmClient } from './openai-agent/llm-client.js'
import type { ClaudeThinkingConfig } from './claude-code/request.js'
import { createLogger } from '../logger.js'

const log = createLogger('llm-client')

/**
 * LLM 调用契约 (BotLoopAgent runRound 用)。
 *
 * 主 agent 目前支持两条 wire path:
 *  - claude-code: Claude Code identity 透传 cliproxy → Anthropic。Anthropic 服务端按
 *    system.0.text 是否以 `x-anthropic-billing-header:` 开头判定 OAuth 信任; 用普通
 *    OpenAI ChatCompletion 形态打 Anthropic 会被服务端注入 Claude Code system prompt,
 *    所以 Claude 主路径必须走 claude-code/。
 *  - openai-agent: OpenAI Chat Completions, 复用同一个 AgentMessage + Tool 契约。
 *
 * 关键不变量:
 *  - input.systemPrompt 和 input.messages 字节稳定 = 1h cache 命中前提
 *  - claude-code/ 不发 temperature (Anthropic reasoning 模型拒收该字段)
 */
export interface LlmCallInput {
  systemPrompt: string
  messages: AgentMessage[]
  tools: Tool[]
  /** 单次生成的输出 token 上限；不改变输入上下文窗口。 */
  maxOutputTokens?: number
  /** 可选调用级取消信号，供旁路/有界任务真正终止底层 HTTP 请求。 */
  signal?: AbortSignal
}

export type LlmStopReason =
  | 'tool_use'
  | 'end_turn'
  | 'max_tokens'
  | 'model_context_window_exceeded'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'
  | 'content_filter'
  | 'unknown'

export interface LlmCallOutput {
  /** Provider 返回的普通 assistant 文本。仅用于观测; BotLoop 不把它写入 AgentContext。 */
  content: string
  toolCalls: AssistantToolCall[]
  nativeBlocks?: ClaudeAssistantNativeBlock[]
  /** 用于观测 cache 命中的 usage。 */
  usage: {
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
  }
  model: string
  /** Provider-neutral 的生成停止原因；unknown 表示上游未提供或无法映射。 */
  stopReason?: LlmStopReason
}

export interface LlmClient {
  chat(input: LlmCallInput): Promise<LlmCallOutput>
}

/** Provider adapter 暴露的稳定失败分类；Runtime Host 不依赖具体 error class。 */
export function isLlmContextOverflowError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'kind' in error
    && error.kind === 'context_overflow',
  )
}

/** 只识别明确的硬额度/账单上限；普通可恢复 429 仍由 provider retry/backoff 处理。 */
export function isLlmUsageLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code.toLowerCase() : ''
  if (['insufficient_quota', 'billing_hard_limit_reached', 'usage_limit_reached'].includes(code)) {
    return true
  }
  if (record.kind === 'usage_limit') return true
  if (record.kind !== 'rate_limit') return false
  const message = typeof record.message === 'string' ? record.message : ''
  return /(?:usage|spend(?:ing)?|billing|credit|quota).{0,40}(?:limit|exceed|exhaust|deplet)|insufficient.{0,20}(?:quota|credit)/i.test(message)
}

/** 只允许 overload/server 触发 model fallback；鉴权、参数、限流和上下文错误保持原样。 */
export function isLlmFallbackEligibleError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('kind' in error) return error.kind === 'overloaded' || error.kind === 'server'
  if (!('status' in error) || typeof error.status !== 'number') return false
  return error.status >= 500 && error.status <= 599
}

export function createFallbackLlmClient(input: {
  primary: LlmClient
  fallback: LlmClient
  primaryModel: string
  fallbackModel: string
}): LlmClient {
  return {
    async chat(request) {
      try {
        return await input.primary.chat(request)
      } catch (err) {
        if (!isLlmFallbackEligibleError(err)) throw err
        log.warn(
          {
            err,
            primaryModel: input.primaryModel,
            fallbackModel: input.fallbackModel,
          },
          'primary_model_unavailable_using_fallback',
        )
        return input.fallback.chat(request)
      }
    },
  }
}

interface CreateLlmClientOptions {
  model?: string
  claudeThinking?: ClaudeThinkingConfig
}

/**
 * URL / apiKey 从 provider 注册表读取:
 *  - claude-code 复用 `config.llm.providers.claude` (LLM_PROVIDER_CLAUDE_*)
 *  - openai-agent 复用 `config.llm.providers.openai` (LLM_PROVIDER_OPENAI_*)
 * 其它 `LLM_DEFAULT_PROVIDER` 会启动期 throw。
 */
export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  const primaryModel = options.model ?? config.llm.defaultModel
  const primary = createProviderLlmClient(primaryModel, options)
  const fallbackModel = options.model == null ? config.llm.fallbackModel : null
  if (!fallbackModel || fallbackModel === primaryModel) return primary

  return createFallbackLlmClient({
    primary,
    fallback: createProviderLlmClient(fallbackModel, options),
    primaryModel,
    fallbackModel,
  })
}

function createProviderLlmClient(model: string, options: CreateLlmClientOptions): LlmClient {
  if (config.llm.defaultProvider === OPENAI_AGENT_PROVIDER_NAME) {
    const openaiProvider = config.llm.providers[OPENAI_AGENT_BASE_PROVIDER_NAME]
    if (!openaiProvider) {
      throw new Error('需要 LLM_PROVIDER_OPENAI_URL / _API_KEY 指向 OpenAI-compatible endpoint')
    }
    return createOpenAIAgentLlmClient({
      model,
      baseURL: openaiProvider.url,
      apiKey: openaiProvider.apiKey,
    })
  }

  if (config.llm.defaultProvider === CLAUDE_CODE_PROVIDER_NAME) {
    const claudeProvider = config.llm.providers[CLAUDE_CODE_BASE_PROVIDER_NAME]
    if (!claudeProvider) {
      throw new Error(
        `需要 LLM_PROVIDER_${CLAUDE_CODE_BASE_PROVIDER_NAME.toUpperCase()}_URL / _API_KEY 指向 cliproxy`,
      )
    }
    return createClaudeCodeLlmClient({
      model,
      baseURL: claudeProvider.url,
      apiKey: claudeProvider.apiKey,
      toolChoice: config.llm.claudeToolChoice,
      thinking: options.claudeThinking ?? config.llm.claudeThinking,
      thinkingLog: { mode: config.llm.claudeThinking.log },
    })
  }

  throw new Error(
    `LLM_DEFAULT_PROVIDER 必须是 ${CLAUDE_CODE_PROVIDER_NAME} 或 ${OPENAI_AGENT_PROVIDER_NAME} (当前: ${config.llm.defaultProvider})`,
  )
}
