/**
 * Anthropic /v1/messages?beta=true request body 构造 (纯函数, 确定性)。
 *
 * 起源是 kagami claude-code-provider.ts:365-470 的字段顺序与 3-block system 形态。
 * 关键不变量:
 *   - 字段顺序: {model, stream, max_tokens, system, messages, tools?, tool_choice?}
 *     (cloak fingerprint 可能看 JSON shape, 不要换序)
 *   - system 为 3 块 text array: billing header → SDK prompt → user persona
 *   - 1h prompt caching 挂在 **最后一块 system block** 上 (per-block), 不放在顶层。
 *     CLAUDE.md 红线 5 对应。
 *   - tools 为空时整个 tools / tool_choice 字段省略 (Anthropic API 不接受 tools:[])
 *   - **不发 temperature**: Claude reasoning 模型 (opus-4-7 / sonnet-4-7 等) 在 API 层
 *     直接拒绝 `temperature` 字段, 报 "temperature is deprecated for this model"。
 *     真 Claude Code CLI 也不发, 它用 thinking_config 控制. 跟它对齐 = 字节稳定 + 不撞错。
 *     上层 LlmCallInput.temperature 仍存在, 由 OpenAI 路径单独 honor。
 *   - thinking / output_config / context_management v1 不发 (out of scope)
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
import type { z } from 'zod'
import { z as zod } from 'zod'
import type { AgentMessage } from '../agent-context.types.js'
import type { Tool } from '../tool.js'
import {
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_SDK_PROMPT,
} from './headers.js'

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
  tools?: Array<Record<string, unknown>>
  tool_choice?: Record<string, unknown>
}

export interface BuildClaudeCodeRequestBodyInput {
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: Tool[]
}

export function buildClaudeCodeRequestBody(
  input: BuildClaudeCodeRequestBodyInput,
): ClaudeMessageRequestBody {
  const toolsEnabled = input.tools.length > 0

  const body: ClaudeMessageRequestBody = {
    model: input.model,
    stream: true,
    max_tokens: resolveMaxTokens(input.model),
    system: toClaudeSystemBlocks(input.systemPrompt),
    messages: input.messages.flatMap(toClaudeMessage),
  }

  if (toolsEnabled) {
    body.tools = input.tools.map(toAnthropicToolDecl)
    body.tool_choice = { type: 'auto' }
  }

  return body
}

export function toClaudeSystemBlocks(userSystem: string): ClaudeSystemBlock[] {
  const blocks: ClaudeSystemBlock[] = [
    { type: 'text', text: CLAUDE_CODE_BILLING_HEADER },
    // { type: 'text', text: CLAUDE_CODE_SDK_PROMPT },
  ]
  if (userSystem.length > 0) {
    blocks.push({ type: 'text', text: userSystem })
  }
  // 1h cache breakpoint: 钉在 system 数组最后一块, 让 cliproxy 不再注入 5m,
  // 同时让 system prefix 整段进 1h cache pool (CLAUDE.md 红线 5)。
  const lastBlock = blocks.at(-1)
  if (lastBlock) {
    lastBlock.cache_control = { type: 'ephemeral', ttl: '1h' }
  }
  return blocks
}

function toClaudeMessage(
  msg: AgentMessage,
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
  return [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        },
      ],
    },
  ]
}

function toAnthropicToolDecl(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: zodToAnthropicSchema(tool.schema),
  }
}

function zodToAnthropicSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zod.toJSONSchema(schema) as Record<string, unknown>
  // Anthropic 要求 input_schema 至少有 type 与 properties (object 的话)。
  // zod 的 toJSONSchema 已经返回 properties; 这里做一次浅 normalize 保 properties 必存在。
  if (json.type === 'object' && !('properties' in json)) {
    json.properties = {}
  }
  return json
}

function resolveMaxTokens(model: string): number {
  if (model.startsWith('claude-sonnet-4-') || model.startsWith('claude-opus-4-')) {
    return CLAUDE_4_MAX_TOKENS
  }
  return DEFAULT_MAX_TOKENS
}
