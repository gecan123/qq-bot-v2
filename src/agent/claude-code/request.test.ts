import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import {
  buildClaudeCodeRequestBody,
  shouldReplayClaudeNativeBlocks,
  toClaudeSystemBlocks,
} from './request.js'
import type { Tool } from '../tool.js'
import type { AgentMessage } from '../agent-context.types.js'
import { CLAUDE_CODE_BILLING_HEADER } from './headers.js'

const dummyTool: Tool = {
  name: 'send_message',
  description: '发一条消息',
  schema: z.object({ text: z.string() }),
  execute: async () => ({ content: 'ok' }),
}

const yieldTool: Tool = {
  name: 'yield',
  description: '交回控制权',
  schema: z.object({}),
  execute: async () => ({ content: 'ok' }),
}

describe('toClaudeSystemBlocks', () => {
  test('returns 2 blocks: billing, user persona', () => {
    const blocks = toClaudeSystemBlocks('I am Mei.')
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]?.text, CLAUDE_CODE_BILLING_HEADER)
    assert.equal(blocks[1]?.text, 'I am Mei.')
    assert.equal(blocks[0]?.type, 'text')
  })

  test('omits user block when persona is empty', () => {
    const blocks = toClaudeSystemBlocks('')
    assert.equal(blocks.length, 1)
  })

  test('cache_control 1h 钉在最后一块 (有 persona 时是 user persona)', () => {
    const blocks = toClaudeSystemBlocks('I am Mei.')
    assert.equal(blocks[0]?.cache_control, undefined)
    assert.deepEqual(blocks[1]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  test('persona 为空时 cache_control 落到 billing header 块上', () => {
    const blocks = toClaudeSystemBlocks('')
    assert.deepEqual(blocks[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  })
})

describe('shouldReplayClaudeNativeBlocks', () => {
  const assistant: AgentMessage = {
    role: 'assistant',
    content: '',
    nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
    toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
  }
  const completedToolCycle: AgentMessage[] = [
    assistant,
    { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
  ]

  test('active-tool-cycle replays only a complete tool cycle at the tail', () => {
    assert.equal(
      shouldReplayClaudeNativeBlocks(completedToolCycle, 0, 'active-tool-cycle'),
      true,
    )
    assert.equal(
      shouldReplayClaudeNativeBlocks([assistant], 0, 'active-tool-cycle'),
      false,
    )
  })

  test('active-tool-cycle stops replaying after a later user message closes the cycle', () => {
    assert.equal(
      shouldReplayClaudeNativeBlocks(
        [...completedToolCycle, { role: 'user', content: 'new input' }],
        0,
        'active-tool-cycle',
      ),
      false,
    )
  })

  test('always replays native blocks after the tool cycle has closed', () => {
    assert.equal(
      shouldReplayClaudeNativeBlocks(
        [...completedToolCycle, { role: 'user', content: 'new input' }],
        0,
        'always',
      ),
      true,
    )
  })

  test('request body retains the existing replay shape selected by the helper', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: completedToolCycle,
      tools: [dummyTool],
      thinking: { mode: 'adaptive', retention: 'active-tool-cycle' },
    })

    assert.equal(
      shouldReplayClaudeNativeBlocks(completedToolCycle, 0, 'active-tool-cycle'),
      true,
    )
    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' } },
      ],
    })
  })
})

describe('buildClaudeCodeRequestBody', () => {
  test('字段顺序 model, stream, max_tokens, system, messages (顶层无 cache_control)', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    assert.deepEqual(Object.keys(body), [
      'model',
      'stream',
      'max_tokens',
      'system',
      'messages',
    ])
  })

  test('cache_control 1h 挂在最后一块 system block (per-block, 不在顶层)', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    assert.equal('cache_control' in body, false)
    assert.equal(body.system.length, 2)
    assert.equal(body.system[0]?.cache_control, undefined)
    assert.deepEqual(body.system[1]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  test('adds a 1h message cache breakpoint at a selected source message index', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 'persona',
      messages: [
        { role: 'user', content: 'old prefix' },
        { role: 'assistant', content: '', toolCalls: [] },
        { role: 'user', content: 'recent tail' },
      ],
      tools: [],
      cacheBreakpointMessageIndexes: [0],
    })

    assert.deepEqual(body.messages[0]?.content.at(-1)?.cache_control, {
      type: 'ephemeral',
      ttl: '1h',
    })
    assert.deepEqual(body.messages[1]?.content.at(-1)?.cache_control, {
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('stream is literally true', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    assert.equal(body.stream, true)
  })

  test('claude-sonnet-4-x picks 32000 max_tokens, others 4096', () => {
    const a = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    const b = buildClaudeCodeRequestBody({
      model: 'claude-haiku-3-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal(a.max_tokens, 32000)
    assert.equal(b.max_tokens, 4096)
  })

  test('call-level maxOutputTokens overrides the model default', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
      maxOutputTokens: 12_345.9,
    })

    assert.equal(body.max_tokens, 12_345)
  })

  test('tools omitted entirely when empty (NOT tools:[])', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal('tools' in body, false)
    assert.equal('tool_choice' in body, false)
  })

  test('thinking omitted by default', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })

    assert.equal('thinking' in body, false)
    assert.equal('output_config' in body, false)
  })

  test('adaptive thinking adds summarized thinking config without tools', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
      thinking: { mode: 'adaptive' },
    })

    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.equal('output_config' in body, false)
    assert.equal('tools' in body, false)
    assert.equal('tool_choice' in body, false)
  })

  test('adaptive thinking sends configured effort through output_config', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'LongCat-2.0',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
      thinking: { mode: 'adaptive', effort: 'max' },
    })

    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.output_config, { effort: 'max' })
  })

  test('disabled thinking omits output_config even when effort is configured', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'LongCat-2.0',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
      thinking: { mode: 'disabled', effort: 'max' },
    })

    assert.equal('thinking' in body, false)
    assert.equal('output_config' in body, false)
  })

  test('tools mapped to {name, description, input_schema}; tool_choice=any', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [dummyTool, yieldTool],
    })
    assert.deepEqual(body.tool_choice, { type: 'any' })
    assert.ok(Array.isArray(body.tools))
    assert.equal(body.tools?.length, 2)
    const sendDecl = body.tools?.[0] as Record<string, unknown>
    assert.equal(sendDecl.name, 'send_message')
    assert.equal(sendDecl.description, '发一条消息')
    const inputSchema = sendDecl.input_schema as Record<string, unknown>
    assert.equal(inputSchema.type, 'object')
  })

  test('uses configured auto tool choice for compatible providers that reject any', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'LongCat-2.0',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [dummyTool],
      toolChoice: 'auto',
    })

    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('adaptive thinking with tools forces tool_choice auto even when any is configured', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [dummyTool],
      toolChoice: 'any',
      thinking: { mode: 'adaptive' },
    })

    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('temperature 字段永不写入 body (reasoning model 拒收, 跟真 Claude Code CLI 对齐)', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-opus-4-7',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal('temperature' in body, false)
  })

  test('user message → role:user with [{type:text}] content', () => {
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })
    assert.deepEqual(body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ])
  })

  test('assistant with text + tool_call → role:assistant with [text, tool_use] content', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'plz say hi' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
      },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [dummyTool],
    })
    const assistantMsg = body.messages[1]
    assert.equal(assistantMsg?.role, 'assistant')
    assert.deepEqual(assistantMsg?.content, [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
  })

  test('active tool-cycle retention replays thinking before tool_use when tool_result is at tail', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
        toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [dummyTool],
      thinking: { mode: 'adaptive', retention: 'active-tool-cycle' },
    })

    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' } },
      ],
    })
  })

  test('native thinking blocks are not replayed when thinking is disabled', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
        toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [dummyTool],
    })

    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' } },
      ],
    })
  })

  test('active tool-cycle retention strips thinking after later user message closes cycle', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'old plan', signature: 'sig' }],
        toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      { role: 'user', content: 'new input' },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [dummyTool],
      thinking: { mode: 'adaptive', retention: 'active-tool-cycle' },
    })

    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' } },
      ],
    })
  })

  test('always retention replays thinking even after tool cycle has later messages', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'old plan', signature: 'sig' }],
        toolCalls: [{ id: 'call_1', name: 'send_message', args: { text: 'hi' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      { role: 'user', content: 'new input' },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [dummyTool],
      thinking: { mode: 'adaptive', retention: 'always' },
    })

    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'old plan', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'send_message', input: { text: 'hi' } },
      ],
    })
  })

  test('tool result → role:user with tool_result content block', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'yield', args: {} }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"status":"yielded"}' },
    ]
    const body = buildClaudeCodeRequestBody({
      model: 'claude-sonnet-4-5',
      systemPrompt: 's',
      messages,
      tools: [yieldTool],
    })
    assert.equal(body.messages.length, 2)
    assert.deepEqual(body.messages[1], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"status":"yielded"}', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    })
  })

  test('deterministic: same input → same output', () => {
    const input = {
      model: 'claude-sonnet-4-5',
      systemPrompt: 'persona',
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [dummyTool],
    }
    const a = JSON.stringify(buildClaudeCodeRequestBody(input))
    const b = JSON.stringify(buildClaudeCodeRequestBody(input))
    assert.equal(a, b)
  })
})
