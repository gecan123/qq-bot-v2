import type { AgentMessage, AssistantToolCall, PersistedAgentSnapshot } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'

export type { AgentMessage, AssistantToolCall, PersistedAgentSnapshot } from './agent-context.types.js'

/**
 * Single-context bot 的 AgentContext。
 *
 * CLAUDE.md「Perpetual Context Contract」红线:
 *  - getSnapshot() 返回深拷贝, 外部修改不影响内部 (字节稳定的前提)
 *  - 仅 appendXxx 和 replaceMessages 两类写口
 *  - replaceMessages 仅 compaction 调用
 *  - 持久形态 == 运行时形态: snapshot.messages 即 LLM 看到的 messages
 */
export interface AgentContext {
  getSnapshot(): { messages: AgentMessage[] }
  appendUserMessage(content: string): void
  appendAssistantTurn(turn: { content: string; toolCalls: AssistantToolCall[] }): void
  appendToolResult(input: { toolCallId: string; content: string }): void
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

  const impl: AgentContext = {
    getSnapshot(): { messages: AgentMessage[] } {
      return { messages: cloneMessages(messages) }
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
    appendToolResult(input: { toolCallId: string; content: string }): void {
      messages.push({
        role: 'tool',
        toolCallId: input.toolCallId,
        content: input.content,
      })
    },
    replaceMessages(next: AgentMessage[]): void {
      messages = cloneMessages(next)
    },
    exportPersistedSnapshot(): PersistedAgentSnapshot {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages: cloneMessages(messages),
      }
    },
    restorePersistedSnapshot(snapshot: PersistedAgentSnapshot): void {
      messages = cloneMessages(snapshot.messages)
    },
    reset(): void {
      messages = []
    },
  }
  return impl
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
      return { role: 'tool', toolCallId: input.toolCallId, content: input.content }
  }
}

function cloneToolCall(call: AssistantToolCall): AssistantToolCall {
  return { id: call.id, name: call.name, args: { ...call.args } }
}
