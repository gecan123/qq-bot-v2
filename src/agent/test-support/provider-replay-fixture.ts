import { z } from 'zod'
import type { AgentMessage } from '../agent-context.types.js'
import type { Tool } from '../tool.js'
import type { LlmStopReason } from '../llm-client.js'

const replayTools: Tool[] = [
  {
    name: 'lookup_fact',
    description: '查询事实',
    schema: z.object({ query: z.string(), limit: z.number().int().positive().optional() }),
    execute: async () => ({ content: 'unused' }),
  },
  {
    name: 'inspect_picture',
    description: '查看图片',
    schema: z.object({ mediaId: z.string() }),
    execute: async () => ({ content: 'unused' }),
  },
]

const replayMessages: AgentMessage[] = [
  { role: 'user', content: '查事实并查看图片。' },
  {
    role: 'assistant',
    content: '',
    nativeBlocks: [{ type: 'thinking', thinking: '先查询，再查看图片。', signature: 'fixture-signature' }],
    toolCalls: [
      { id: 'call_lookup', name: 'lookup_fact', args: { limit: 3, query: '永续上下文' } },
      { id: 'call_image', name: 'inspect_picture', args: { mediaId: 'media_fixture' } },
    ],
  },
  {
    role: 'tool',
    toolCallId: 'call_lookup',
    content: '{"ok":true,"facts":["ledger is canonical"]}',
  },
  {
    role: 'tool',
    toolCallId: 'call_image',
    content: [
      { type: 'text', text: '{"ok":true,"description":"one pixel"}' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        },
      },
    ],
  },
]

/** 同一 provider-neutral replay 输入，供所有 adapter 的 wire contract 共用。 */
export const providerReplayFixture = Object.freeze({
  systemPrompt: '你是 replay conformance fixture。',
  messages: replayMessages,
  tools: replayTools,
})

export const providerStopReasonFixtures: ReadonlyArray<{
  expected: LlmStopReason
  openAI: string
  claude: string
}> = Object.freeze([
  { expected: 'tool_use', openAI: 'tool_calls', claude: 'tool_use' },
  { expected: 'end_turn', openAI: 'stop', claude: 'end_turn' },
  { expected: 'max_tokens', openAI: 'length', claude: 'max_tokens' },
])

export const providerOverflowFixture = Object.freeze({
  type: 'context_length_exceeded',
  message: 'maximum context length exceeded',
  contextWindowTokens: 200_000,
})
