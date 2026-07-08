import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseClaudeStreamResponse, parseClaudeMessageResponse } from './sse-parser.js'

function ev(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('parseClaudeStreamResponse', () => {
  test('returns null for non-SSE strings', () => {
    assert.equal(parseClaudeStreamResponse('not sse'), null)
    assert.equal(parseClaudeStreamResponse('{"json":1}'), null)
  })

  test('text-only stream: accumulates text_delta into one text block', () => {
    const sse =
      ev('message_start', {
        type: 'message_start',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 0 } },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello ' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        usage: { output_tokens: 8, cache_read_input_tokens: 100 },
      })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.equal(result.model, 'claude-sonnet-4-5')
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello world' }])
    assert.equal(result.usage?.input_tokens, 10)
    assert.equal(result.usage?.output_tokens, 8)
    assert.equal(result.usage?.cache_read_input_tokens, 100)
  })

  test('tool_use stream: accumulates input_json_delta into parsed input', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'send_message' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"text":' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"hi"}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.equal(result.content?.length, 1)
    const block = result.content?.[0]
    assert.ok(block && 'type' in block && block.type === 'tool_use')
    if (block && block.type === 'tool_use') {
      assert.equal(block.id, 'tu_1')
      assert.equal(block.name, 'send_message')
      assert.deepEqual(block.input, { text: 'hi' })
    }
  })

  test('thinking stream: accumulates thinking_delta and preserves signature', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: 'sig_1' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'first ' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'second' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })

    const result = parseClaudeStreamResponse(sse)

    assert.ok(result)
    assert.deepEqual(result.content, [
      { type: 'thinking', thinking: 'first second', signature: 'sig_1' },
    ])
  })

  test('thinking stream: applies signature_delta before block stop', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'private thought' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_final' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })

    const result = parseClaudeStreamResponse(sse)

    assert.ok(result)
    assert.deepEqual(result.content, [
      { type: 'thinking', thinking: 'private thought', signature: 'sig_final' },
    ])
  })

  test('redacted_thinking block start preserves data', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'opaque' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })

    const result = parseClaudeStreamResponse(sse)

    assert.ok(result)
    assert.deepEqual(result.content, [{ type: 'redacted_thinking', data: 'opaque' }])
  })

  test('mixed text + tool_use blocks at different indices', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '思考' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_X', name: 'wait' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.equal(result.content?.length, 2)
    assert.equal(result.content?.[0]?.type, 'text')
    assert.equal(result.content?.[1]?.type, 'tool_use')
  })

  test('malformed chunks are skipped, not thrown', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      'event: noise\ndata: not json\n\n' +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }])
  })

  test('returns empty content when stream has no content blocks (model chose end_turn silently)', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('message_delta', { type: 'message_delta', usage: { output_tokens: 1 } })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.deepEqual(result.content, [])
    assert.equal(result.usage?.output_tokens, 1)
  })

  test('preserves upstream SSE error events instead of treating them as empty content', () => {
    const sse = ev('error', {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'Overloaded',
      },
    })

    const result = parseClaudeStreamResponse(sse)

    assert.ok(result)
    assert.deepEqual(result.error, {
      type: 'overloaded_error',
      message: 'Overloaded',
    })
    assert.deepEqual(result.content, [])
  })

  test('unknown content block type at index → ignored, no crash', () => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'image', source: 'foo' },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'good' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 })
    const result = parseClaudeStreamResponse(sse)
    assert.ok(result)
    assert.deepEqual(result.content, [{ type: 'text', text: 'good' }])
  })
})

describe('parseClaudeMessageResponse fallback', () => {
  test('falls back to JSON.parse when not SSE', () => {
    const json = JSON.stringify({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    })
    const result = parseClaudeMessageResponse(json)
    assert.ok(result)
    assert.deepEqual(result.content, [{ type: 'text', text: 'hi' }])
    assert.equal(result.usage?.input_tokens, 5)
  })

  test('returns null on garbage', () => {
    assert.equal(parseClaudeMessageResponse('garbage'), null)
  })
})
