import type {
  AssistantToolCall,
  ClaudeAssistantNativeBlock,
  DurableAgentMessage,
  PersistedAgentSnapshot,
  ToolResultContent,
  ToolResultContentBlock,
} from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'

export type {
  AssistantToolCall,
  ClaudeAssistantNativeBlock,
  DurableAgentMessage,
  PersistedAgentSnapshot,
} from './agent-context.types.js'

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
  getSnapshot(): { messages: DurableAgentMessage[]; activeToolCapabilities: string[] }
  appendUserMessage(content: string): void
  appendAssistantTurn(turn: {
    content: string
    toolCalls: AssistantToolCall[]
    nativeBlocks?: ClaudeAssistantNativeBlock[]
  }): void
  appendToolResult(input: { toolCallId: string; content: ToolResultContent }): void
  activateToolCapability(capability: string): void
  deactivateToolCapability(capability: string): void
  /** compaction 唯一写口。原子替换全部 messages。 */
  replaceMessages(messages: DurableAgentMessage[]): void
  /** Runtime Host 在 canonical commit/reload 后安装完整 projection。 */
  installProjection(snapshot: PersistedAgentSnapshot): void
  exportPersistedSnapshot(): PersistedAgentSnapshot
  restorePersistedSnapshot(snapshot: PersistedAgentSnapshot): void
  /** 测试用。 */
  reset(): void
}

interface CreateAgentContextOptions {
  initialMessages?: DurableAgentMessage[]
}

export function createAgentContext(options: CreateAgentContextOptions = {}): AgentContext {
  let messages: DurableAgentMessage[] = options.initialMessages ? cloneMessages(options.initialMessages) : []
  let activeToolCapabilities: string[] = []

  const impl: AgentContext = {
    getSnapshot(): { messages: DurableAgentMessage[]; activeToolCapabilities: string[] } {
      return {
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
      }
    },
    appendUserMessage(content: string): void {
      messages.push({ role: 'user', content })
    },
    appendAssistantTurn(turn: {
      content: string
      toolCalls: AssistantToolCall[]
      nativeBlocks?: ClaudeAssistantNativeBlock[]
    }): void {
      const message: DurableAgentMessage = {
        role: 'assistant',
        content: turn.content,
        toolCalls: turn.toolCalls.map(cloneToolCall),
      }
      if (turn.nativeBlocks !== undefined) {
        message.nativeBlocks = cloneNativeBlocks(turn.nativeBlocks)
      }
      messages.push(message)
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
    replaceMessages(next: DurableAgentMessage[]): void {
      messages = cloneMessages(next)
    },
    installProjection(snapshot: PersistedAgentSnapshot): void {
      const validation = validateBotSnapshotIntegrity({
        snapshot,
        mailboxCursors: {},
        goalRevision: 0,
      })
      if (!validation.ok) {
        throw new Error(`projection integrity validation failed: ${validation.errors.join('; ')}`)
      }
      const nextMessages = cloneMessages(snapshot.messages)
      const nextCapabilities = [...snapshot.activeToolCapabilities]
      messages = nextMessages
      activeToolCapabilities = nextCapabilities
    },
    exportPersistedSnapshot(): PersistedAgentSnapshot {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
      }
    },
    restorePersistedSnapshot(snapshot: PersistedAgentSnapshot): void {
      impl.installProjection({
        ...snapshot,
        activeToolCapabilities: sanitizeToolCapabilities(snapshot.activeToolCapabilities),
      })
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

function cloneMessages(input: DurableAgentMessage[]): DurableAgentMessage[] {
  return input.map(cloneMessage)
}

function cloneMessage(input: DurableAgentMessage): DurableAgentMessage {
  switch (input.role) {
    case 'user':
      return { role: 'user', content: input.content }
    case 'assistant':
      {
        const output: DurableAgentMessage = {
          role: 'assistant',
          content: input.content,
          toolCalls: input.toolCalls.map(cloneToolCall),
        }
        if (input.nativeBlocks !== undefined) {
          output.nativeBlocks = cloneNativeBlocks(input.nativeBlocks)
        }
        return output
      }
    case 'tool':
      return {
        role: 'tool',
        toolCallId: input.toolCallId,
        content: cloneToolResultContent(input.content),
      }
  }
}

function cloneNativeBlocks(blocks: ClaudeAssistantNativeBlock[]): ClaudeAssistantNativeBlock[] {
  return blocks.map(cloneNativeBlock)
}

function cloneNativeBlock(block: ClaudeAssistantNativeBlock): ClaudeAssistantNativeBlock {
  return cloneJsonLike(block) as ClaudeAssistantNativeBlock
}

function cloneToolResultContent(content: ToolResultContent): ToolResultContent {
  if (typeof content === 'string') return content
  return content.map(cloneToolResultBlock)
}

function cloneToolResultBlock(block: ToolResultContentBlock): ToolResultContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'image_ref') return {
    type: 'image_ref',
    mediaId: block.mediaId,
    mediaType: block.mediaType,
    ...(block.width == null ? {} : { width: block.width }),
    ...(block.height == null ? {} : { height: block.height }),
    ...(block.description == null ? {} : { description: block.description }),
  }
  return {
    type: 'image',
    source: { ...block.source },
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
