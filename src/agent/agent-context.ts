import type {
  AssistantToolCall,
  ClaudeAssistantNativeBlock,
  DurableAgentMessage,
  PersistedAgentSnapshot,
  QqConversationFocus,
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
  QqConversationFocus,
  ToolResultContent,
} from './agent-context.types.js'

/**
 * Single-context bot 的 AgentContext。
 *
 * AGENTS.md / CLAUDE.md「永续上下文契约」红线:
 *  - getSnapshot() 返回深拷贝, 外部修改不影响内部 (字节稳定的前提)
 *  - 主 Runtime Host 只能在 canonical commit/reload 后用 installProjection 整体安装
 *  - appendXxx 只服务不持久化的局部 AgentContext 和测试 fixture
 *  - 持久形态 == 运行时形态; snapshot.messages 是 LLM 看到的 messages,
 *    activeToolCapabilities 是 runtime control state, 不进 LLM messages。
 */
export interface AgentContext {
  getSnapshot(): {
    messages: DurableAgentMessage[]
    activeToolCapabilities: string[]
    qqConversationFocus: QqConversationFocus
  }
  appendUserMessage(content: string): void
  appendAssistantTurn(turn: {
    content: string
    toolCalls: AssistantToolCall[]
    nativeBlocks?: ClaudeAssistantNativeBlock[]
  }): void
  appendToolResult(input: { toolCallId: string; content: ToolResultContent }): void
  activateToolCapability(capability: string): void
  deactivateToolCapability(capability: string): void
  /** Runtime Host 在 canonical commit/reload 后安装完整 projection。 */
  installProjection(snapshot: PersistedAgentSnapshot): void
  exportPersistedSnapshot(): PersistedAgentSnapshot
  /** 测试用。 */
  reset(): void
}

interface CreateAgentContextOptions {
  initialMessages?: DurableAgentMessage[]
}

export function createAgentContext(options: CreateAgentContextOptions = {}): AgentContext {
  let messages: DurableAgentMessage[] = options.initialMessages ? cloneMessages(options.initialMessages) : []
  let activeToolCapabilities: string[] = []
  let qqConversationFocus: QqConversationFocus = null

  const impl: AgentContext = {
    getSnapshot(): {
      messages: DurableAgentMessage[]
      activeToolCapabilities: string[]
      qqConversationFocus: QqConversationFocus
    } {
      return {
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
        qqConversationFocus: cloneQqConversationFocus(qqConversationFocus),
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
      const nextQqConversationFocus = cloneQqConversationFocus(snapshot.qqConversationFocus)
      messages = nextMessages
      activeToolCapabilities = nextCapabilities
      qqConversationFocus = nextQqConversationFocus
    },
    exportPersistedSnapshot(): PersistedAgentSnapshot {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages: cloneMessages(messages),
        activeToolCapabilities: [...activeToolCapabilities],
        qqConversationFocus: cloneQqConversationFocus(qqConversationFocus),
      }
    },
    reset(): void {
      messages = []
      activeToolCapabilities = []
      qqConversationFocus = null
    },
  }
  return impl
}

function cloneQqConversationFocus(focus: QqConversationFocus): QqConversationFocus {
  if (focus == null) return null
  return focus.type === 'group'
    ? { type: 'group', groupId: focus.groupId }
    : { type: 'private', userId: focus.userId }
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
