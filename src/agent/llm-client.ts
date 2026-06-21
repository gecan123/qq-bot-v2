import type { AgentMessage } from './agent-context.types.js'
import type { Tool } from './tool.js'
import type { AssistantToolCall } from './agent-context.types.js'
import {
  CLAUDE_CODE_BASE_PROVIDER_NAME,
  CLAUDE_CODE_PROVIDER_NAME,
  config,
  OPENAI_AGENT_BASE_PROVIDER_NAME,
  OPENAI_AGENT_PROVIDER_NAME,
} from '../config/index.js'
import { createClaudeCodeLlmClient } from './claude-code/llm-client.js'
import { createOpenAIAgentLlmClient } from './openai-agent/llm-client.js'

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
}

export interface LlmCallOutput {
  /** Provider 返回的普通 assistant 文本。仅用于观测; BotLoop 不把它写入 AgentContext。 */
  content: string
  toolCalls: AssistantToolCall[]
  /** 用于观测 cache 命中的 usage。 */
  usage: {
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
  }
  model: string
}

export interface LlmClient {
  chat(input: LlmCallInput): Promise<LlmCallOutput>
}

interface CreateLlmClientOptions {
  model?: string
}

/**
 * URL / apiKey 从 provider 注册表读取:
 *  - claude-code 复用 `config.llm.providers.claude` (LLM_PROVIDER_CLAUDE_*)
 *  - openai-agent 复用 `config.llm.providers.openai` (LLM_PROVIDER_OPENAI_*)
 * 其它 `LLM_DEFAULT_PROVIDER` 会启动期 throw。
 */
export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  if (config.llm.defaultProvider === OPENAI_AGENT_PROVIDER_NAME) {
    const openaiProvider = config.llm.providers[OPENAI_AGENT_BASE_PROVIDER_NAME]
    if (!openaiProvider) {
      throw new Error('需要 LLM_PROVIDER_OPENAI_URL / _API_KEY 指向 OpenAI-compatible endpoint')
    }
    return createOpenAIAgentLlmClient({
      model: options.model ?? config.llm.defaultModel,
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
      model: options.model ?? config.llm.defaultModel,
      baseURL: claudeProvider.url,
      apiKey: claudeProvider.apiKey,
    })
  }

  throw new Error(
    `LLM_DEFAULT_PROVIDER 必须是 ${CLAUDE_CODE_PROVIDER_NAME} 或 ${OPENAI_AGENT_PROVIDER_NAME} (当前: ${config.llm.defaultProvider})`,
  )
}
