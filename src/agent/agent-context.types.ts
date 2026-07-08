/**
 * AgentContext 里 LLM 看到的 message 联合类型。
 *
 * 设计原则:与 OpenAI ChatCompletion 协议形态接近,以便 llm-client 翻译时是 1:1 映射,
 * 避免每次重渲染时引入新的字节噪声(永续上下文 cache 命中前提)。
 *
 * - 不包含 'system': 系统提示由调用方在 buildLlmRequest 时拼到最前,不进 messages 数组
 *   (避免每次拷贝/序列化时改变 system prompt 的 KV cache 占位)。
 * - 'tool' 单独成为一种 role: 一个 assistant turn 可能有 N 个 toolCalls,对应 N 个 tool
 *   role messages,顺序与 toolCallId 锚定。
 */

export interface AssistantToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type ClaudeAssistantNativeBlock =
  | { type: 'thinking'; thinking?: string; signature?: string; [key: string]: unknown }
  | { type: 'redacted_thinking'; data?: string; [key: string]: unknown }

export interface ToolResultTextBlock {
  type: 'text'
  text: string
}

export interface ToolResultImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export type ToolResultContentBlock = ToolResultTextBlock | ToolResultImageBlock

export type ToolResultContent = string | ToolResultContentBlock[]

export type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls: AssistantToolCall[]
      nativeBlocks?: ClaudeAssistantNativeBlock[]
    }
  | { role: 'tool'; toolCallId: string; content: ToolResultContent }

/**
 * 持久化形态。runtime 形态 == 这个对象 (AGENTS.md / CLAUDE.md 红线 1)。
 */
export interface PersistedAgentSnapshot {
  schemaVersion: number
  messages: AgentMessage[]
  activeToolCapabilities: string[]
}

export const SNAPSHOT_SCHEMA_VERSION = 3
