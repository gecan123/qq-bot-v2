import type { AgentMessage } from './agent-context.types.js'
import type { Tool } from './tool.js'
import type { AssistantToolCall } from './agent-context.types.js'
import {
  CLAUDE_CODE_BASE_PROVIDER_NAME,
  CLAUDE_CODE_PROVIDER_NAME,
  config,
} from '../config/index.js'
import { createClaudeCodeLlmClient } from './claude-code/llm-client.js'

/**
 * LLM 调用契约 (BotLoopAgent runRound 用)。
 *
 * 这条路径**只**走 Claude Code identity 透传 cliproxy → Anthropic
 * (src/agent/claude-code/llm-client.ts)。Anthropic 服务端按 system.0.text 是否
 * 以 `x-anthropic-billing-header:` 开头判定 OAuth 信任; 用 OpenAI ChatCompletion
 * 形态过去 = system 第一块不是 billing 头 = 服务端注入 ~2000 token 的 Claude Code
 * system prompt 把用户人设覆盖掉, Luna 直接没了。所以 agent chat 必须走 claude-code/。
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
  /** 模型在 assistant message 里写的"思考"内容(可空)。 */
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
 * URL / apiKey 从 `config.llm.providers.claude` (即 LLM_PROVIDER_CLAUDE_*) 读, 指向
 * cliproxy。`LLM_DEFAULT_PROVIDER` 必须是 `claude-code`; 其它值会启动期 throw,
 * 因为 agent 走任何非 claude-code 路径都会被 Anthropic 服务端劫持人设 (上面注释)。
 */
export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  if (config.llm.defaultProvider !== CLAUDE_CODE_PROVIDER_NAME) {
    throw new Error(
      `LLM_DEFAULT_PROVIDER 必须是 ${CLAUDE_CODE_PROVIDER_NAME} (当前: ${config.llm.defaultProvider}); agent chat 路径只支持 claude-code identity 透传 cliproxy`,
    )
  }
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
