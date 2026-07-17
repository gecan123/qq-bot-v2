/**
 * Anthropic /v1/messages?beta=true request body 构造 (纯函数, 确定性)。
 *
 * 起源是 kagami claude-code-provider.ts:365-470 的字段顺序与 3-block system 形态。
 * 关键不变量:
 *   - 字段顺序: {model, stream, max_tokens, system, messages, tools?, tool_choice?}
 *     (cloak fingerprint 可能看 JSON shape, 不要换序)
 *   - system 为 3 块 text array: billing header → SDK prompt → user persona
 *   - 1h prompt caching 挂在 **最后一块 system block** 上 (per-block), 不放在顶层。
 *     AGENTS.md / CLAUDE.md 红线 5 对应。
 *   - tools 为空时整个 tools / tool_choice 字段省略 (Anthropic API 不接受 tools:[])
 *   - **不发 temperature**: Claude reasoning 模型 (opus-4-7 / sonnet-4-7 等) 在 API 层
 *     直接拒绝 `temperature` 字段, 报 "temperature is deprecated for this model"。
 *     真 Claude Code CLI 也不发, 它用 thinking_config 控制. 跟它对齐 = 字节稳定 + 不撞错。
 *     上层 LlmCallInput.temperature 仍存在, 由 OpenAI 路径单独 honor。
 *   - thinking 默认不发; 只有 claudeThinking.mode=adaptive 时发送 summarized adaptive thinking。
 *   - output_config / context_management v1 不发 (out of scope)
 *
 * 为什么是 per-block 而不是 kagami 那种顶层 cache_control:
 *   kagami 自家 OAuth 直连 Anthropic, 顶层 cache_control 自动模式 work。
 *   qq-bot-v2 走 cliproxy → Anthropic, cliproxy 6.10.x 的
 *   internal/runtime/executor/claude_executor.go ensureCacheControl 在
 *   countCacheControls(body)==0 时会自动给 last system block 注入 5m cache_control,
 *   而 countCacheControls 只数 per-block, 不数顶层 → 顶层 1h + 注入 5m 同时存在 →
 *   触发 "ttl='1h' must not come after ttl='5m'" 报错。
 *   挂在最后一块 system block 上 cliproxy 数得到 ≥1 就跳过注入, 字节稳定不变。
 *   形态也跟当前真 Claude Code (issue anthropics/claude-code#49139) 对齐。
 */
import type {
  AgentMessage,
  ClaudeAssistantNativeBlock,
  ToolResultContentBlock,
} from '../agent-context.types.js'
import type { Tool } from '../tool.js'
import { CLAUDE_CODE_BILLING_HEADER } from './headers.js'
import { zodToToolJsonSchema } from '../tool-schema.js'

const DEFAULT_MAX_TOKENS = 4096
const CLAUDE_4_MAX_TOKENS = 32000

export interface ClaudeCacheControl {
  type: 'ephemeral'
  ttl: '1h'
}

export interface ClaudeSystemBlock {
  type: 'text'
  text: string
  cache_control?: ClaudeCacheControl
}

export interface ClaudeMessageRequestBody {
  model: string
  stream: true
  max_tokens: number
  system: ClaudeSystemBlock[]
  messages: Array<{
    role: 'user' | 'assistant'
    content: Array<Record<string, unknown>>
  }>
  thinking?: {
    type: 'adaptive'
    display: 'summarized'
  }
  tools?: Array<Record<string, unknown>>
  tool_choice?: Record<string, unknown>
}

export type ClaudeToolChoice = 'any' | 'auto'
export type ClaudeThinkingMode = 'disabled' | 'adaptive'
export type ClaudeThinkingRetention = 'active-tool-cycle' | 'always'

export interface ClaudeThinkingConfig {
  mode: ClaudeThinkingMode
  retention?: ClaudeThinkingRetention
}

export interface BuildClaudeCodeRequestBodyInput {
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: Tool[]
  cacheBreakpointMessageIndexes?: readonly number[]
  maxOutputTokens?: number
  toolChoice?: ClaudeToolChoice
  thinking?: ClaudeThinkingConfig
}

export function buildClaudeCodeRequestBody(
  input: BuildClaudeCodeRequestBodyInput,
): ClaudeMessageRequestBody {
  const toolsEnabled = input.tools.length > 0
  const adaptiveThinkingEnabled = input.thinking?.mode === 'adaptive'
  const thinkingRetention = input.thinking?.retention ?? 'active-tool-cycle'
  const messages: ClaudeMessageRequestBody['messages'] = []
  const emittedMessageIndexBySource = new Map<number, number>()
  for (const [sourceIndex, message] of input.messages.entries()) {
    const emitted = toClaudeMessage(
      message,
      adaptiveThinkingEnabled &&
        shouldReplayClaudeNativeBlocks(input.messages, sourceIndex, thinkingRetention),
    )
    if (emitted.length === 0) continue
    messages.push(...emitted)
    emittedMessageIndexBySource.set(sourceIndex, messages.length - 1)
  }

  const body: ClaudeMessageRequestBody = {
    model: input.model,
    stream: true,
    max_tokens: normalizeMaxOutputTokens(input.maxOutputTokens) ?? resolveMaxTokens(input.model),
    system: toClaudeSystemBlocks(input.systemPrompt),
    messages,
  }

  if (adaptiveThinkingEnabled) {
    body.thinking = { type: 'adaptive', display: 'summarized' }
  }

  if (toolsEnabled) {
    body.tools = input.tools.map(toAnthropicToolDecl)
    body.tool_choice = { type: adaptiveThinkingEnabled ? 'auto' : input.toolChoice ?? 'any' }
  }

  // 1h cache breakpoint: 钉在 messages 最后一条的最后一个 content block 上,
  // 让整段 messages prefix 进 1h cache pool。下一轮追加 2 条新消息后,
  // 本轮的 cache 仍作为 prefix 命中 — 只有新增部分 uncached (~500 tokens)。
  // 没有这个 breakpoint 时 messages 只有 auto-cache (~5min TTL),
  // wait 工具挂 >5min 后整段 ~750k messages 全部 miss。
  for (const sourceIndex of input.cacheBreakpointMessageIndexes ?? []) {
    const emittedIndex = emittedMessageIndexBySource.get(sourceIndex)
    if (emittedIndex != null) applyMessageCacheBreakpoint(body.messages[emittedIndex])
  }
  applyMessageCacheBreakpoint(body.messages.at(-1))

  return body
}

function applyMessageCacheBreakpoint(
  message: ClaudeMessageRequestBody['messages'][number] | undefined,
): void {
  const lastBlock = message?.content.at(-1)
  if (lastBlock) lastBlock.cache_control = { type: 'ephemeral', ttl: '1h' }
}

function normalizeMaxOutputTokens(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.floor(value))
}

export function toClaudeSystemBlocks(userSystem: string): ClaudeSystemBlock[] {
  const blocks: ClaudeSystemBlock[] = [
    { type: 'text', text: CLAUDE_CODE_BILLING_HEADER },
  ]
  if (userSystem.length > 0) {
    blocks.push({ type: 'text', text: userSystem })
  }
  // 1h cache breakpoint: 钉在 system 数组最后一块, 让 cliproxy 不再注入 5m,
  // 同时让 system prefix 整段进 1h cache pool (AGENTS.md / CLAUDE.md 红线 5)。
  const lastBlock = blocks.at(-1)
  if (lastBlock) {
    lastBlock.cache_control = { type: 'ephemeral', ttl: '1h' }
  }
  return blocks
}

function toClaudeMessage(
  msg: AgentMessage,
  replayNativeBlocks = false,
): Array<ClaudeMessageRequestBody['messages'][number]> {
  if (msg.role === 'user') {
    return [
      {
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
      },
    ]
  }

  if (msg.role === 'assistant') {
    const content: Array<Record<string, unknown>> = []
    if (replayNativeBlocks) {
      content.push(...(msg.nativeBlocks ?? []).map(toAnthropicNativeBlock))
    }
    if (msg.content.length > 0) {
      content.push({ type: 'text', text: msg.content })
    }
    for (const call of msg.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.args,
      })
    }
    return content.length > 0 ? [{ role: 'assistant', content }] : []
  }

  // role === 'tool': 在 Anthropic 协议里 tool result 用 user role 包裹 tool_result content block
  const toolResultContent = typeof msg.content === 'string'
    ? msg.content
    : msg.content.map(toAnthropicToolResultBlock)

  return [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: toolResultContent,
        },
      ],
    },
  ]
}

export function shouldReplayClaudeNativeBlocks(
  messages: AgentMessage[],
  index: number,
  retention: ClaudeThinkingRetention,
): boolean {
  const msg = messages[index]
  if (!msg || msg.role !== 'assistant' || !msg.nativeBlocks || msg.nativeBlocks.length === 0) {
    return false
  }
  if (retention === 'always') return true
  if (msg.toolCalls.length === 0) return false

  const pendingToolCallIds = new Set(msg.toolCalls.map((call) => call.id))
  let cursor = index + 1
  while (cursor < messages.length) {
    const next = messages[cursor]
    if (!next || next.role !== 'tool' || !pendingToolCallIds.has(next.toolCallId)) break
    pendingToolCallIds.delete(next.toolCallId)
    cursor += 1
  }

  return pendingToolCallIds.size === 0 && cursor === messages.length
}

function toAnthropicNativeBlock(block: ClaudeAssistantNativeBlock): Record<string, unknown> {
  return cloneJsonObject(block)
}

function cloneJsonObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    output[key] = cloneJsonValue(value)
  }
  return output
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  return cloneJsonObject(value as Record<string, unknown>)
}

function toAnthropicToolResultBlock(
  block: ToolResultContentBlock,
): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'image_ref') {
    return { type: 'text', text: JSON.stringify(block) }
  }
  return {
    type: 'image',
    source: {
      type: block.source.type,
      media_type: block.source.media_type,
      data: block.source.data,
    },
  }
}

function toAnthropicToolDecl(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: zodToToolJsonSchema(tool.schema),
  }
}

function resolveMaxTokens(model: string): number {
  if (model.startsWith('claude-sonnet-4-') || model.startsWith('claude-opus-4-')) {
    return CLAUDE_4_MAX_TOKENS
  }
  return DEFAULT_MAX_TOKENS
}
