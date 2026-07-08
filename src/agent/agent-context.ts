import type { AgentMessage, AssistantToolCall, PersistedAgentSnapshot, ToolResultContent, ToolResultContentBlock } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'

export type { AgentMessage, AssistantToolCall, PersistedAgentSnapshot, ToolResultContent } from './agent-context.types.js'

/**
 * Single-context bot 的 AgentContext。
 *
 * AGENTS.md / CLAUDE.md「永续上下文契约」红线:
 *  - getSnapshot() 返回深拷贝, 外部修改不影响内部 (字节稳定的前提)
 *  - messages 仅 appendXxx 和 replaceMessages 两类写口
 *  - replaceMessages 仅 compaction 调用
 *  - 持久形态 == 运行时形态; snapshot.messages 是 LLM 看到的 messages,
 *    activeToolCapabilities 是 runtime control state, 不进 LLM messages。
 */
export interface AgentContext {
  getSnapshot(): { messages: AgentMessage[]; activeToolCapabilities: string[] }
  appendUserMessage(content: string): void
  appendAssistantTurn(turn: { content: string; toolCalls: AssistantToolCall[] }): void
  appendToolResult(input: { toolCallId: string; content: ToolResultContent }): void
  activateToolCapability(capability: string): void
  deactivateToolCapability(capability: string): void
  /** compaction 唯一写口。原子替换全部 messages。 */
  replaceMessages(messages: AgentMessage[]): void
  exportPersistedSnapshot(): PersistedAgentSnapshot
  restorePersistedSnapshot(snapshot: PersistedAgentSnapshot): void
  /** 测试用。 */
  reset(): void
}

interface CreateAgentContextOptions {
  initialMessages?: AgentMessage[]
}

export function createAgentContext(options: CreateAgentContextOptions = {}): AgentContext {
  let messages: AgentMessage[] = options.initialMessages ? cloneMessages(options.initialMessages) : []
  let activeToolCapabilities: string[] = []

  const impl: AgentContext = {
    getSnapshot(): { messages: AgentMessage[]; activeToolCapabilities: string[] } {
      return {
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
      }
    },
    appendUserMessage(content: string): void {
      messages.push({ role: 'user', content })
    },
    appendAssistantTurn(turn: { content: string; toolCalls: AssistantToolCall[] }): void {
      messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: turn.toolCalls.map(cloneToolCall),
      })
    },
    appendToolResult(input: { toolCallId: string; content: ToolResultContent }): void {
      messages.push({
        role: 'tool',
        toolCallId: input.toolCallId,
        content: input.content,
      })
    },
    activateToolCapability(capability: string): void {
      if (!activeToolCapabilities.includes(capability)) {
        activeToolCapabilities = [...activeToolCapabilities, capability]
      }
    },
    deactivateToolCapability(capability: string): void {
      activeToolCapabilities = activeToolCapabilities.filter((item) => item !== capability)
    },
    replaceMessages(next: AgentMessage[]): void {
      messages = cloneMessages(next)
    },
    exportPersistedSnapshot(): PersistedAgentSnapshot {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
      }
    },
    restorePersistedSnapshot(snapshot: PersistedAgentSnapshot): void {
      messages = cloneMessages(snapshot.messages)
      activeToolCapabilities = sanitizeToolCapabilities(snapshot.activeToolCapabilities)
    },
    reset(): void {
      messages = []
      activeToolCapabilities = []
    },
  }
  return impl
}

function sanitizeToolCapabilities(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const capability = item.trim()
    if (!capability || seen.has(capability)) continue
    seen.add(capability)
    output.push(capability)
  }
  return output
}

function cloneMessages(input: AgentMessage[]): AgentMessage[] {
  return input.map(cloneMessage)
}

function cloneMessage(input: AgentMessage): AgentMessage {
  switch (input.role) {
    case 'user':
      return { role: 'user', content: input.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: input.content,
        toolCalls: input.toolCalls.map(cloneToolCall),
      }
    case 'tool':
      return {
        role: 'tool',
        toolCallId: input.toolCallId,
        content: cloneToolResultContent(input.content),
      }
  }
}

function cloneToolResultContent(content: ToolResultContent): ToolResultContent {
  if (typeof content === 'string') return content
  return content.map(cloneToolResultBlock)
}

function cloneToolResultBlock(block: ToolResultContentBlock): ToolResultContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: block.source.media_type,
      data: block.source.data,
    },
  }
}

function cloneToolCall(call: AssistantToolCall): AssistantToolCall {
  return { id: call.id, name: call.name, args: cloneToolCallArgs(call.args) }
}

function cloneToolCallArgs(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    output[key] = cloneJsonLike(value)
  }
  return output
}

function cloneJsonLike(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJsonLike)

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = cloneJsonLike(nestedValue)
  }
  return output
}
