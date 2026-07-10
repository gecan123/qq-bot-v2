import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { WSSendReturn } from 'node-napcat-ts'
import * as parser from './message-parser.js'

type NapcatMessage = WSSendReturn['get_msg']

function message(
  messageId: number,
  userId: number,
  nickname: string,
  segments: unknown[],
): NapcatMessage {
  return {
    message_type: 'group',
    group_id: 100,
    sender: { user_id: userId, nickname, card: '', role: 'member' },
    sub_type: 'normal',
    self_id: 999,
    user_id: userId,
    time: 1_700_000_000,
    message_id: messageId,
    message_seq: messageId,
    real_id: messageId,
    real_seq: String(messageId),
    raw_message: '',
    font: 0,
    post_type: 'message',
    emoji_likes_list: [],
    message_format: 'array',
    message: segments,
  } as unknown as NapcatMessage
}

interface ForwardLoader {
  get_forward_msg(args: { message_id: string }): Promise<{ messages: NapcatMessage[] }>
  get_msg(args: { message_id: number }): Promise<NapcatMessage>
}

type ParseMessageWithForwards = (
  input: NapcatMessage,
  loader: ForwardLoader,
) => Promise<ReturnType<typeof parser.parseMessage>>

function forwardParser(): ParseMessageWithForwards {
  const candidate = (parser as unknown as { parseMessageWithForwards?: ParseMessageWithForwards }).parseMessageWithForwards
  assert.equal(typeof candidate, 'function', 'parseMessageWithForwards must be exported')
  if (!candidate) throw new Error('parseMessageWithForwards must be exported')
  return candidate
}

describe('parseMessageWithForwards', () => {
  test('loads forward children and normalizes each child through get_msg', async () => {
    const childStub = message(11, 101, 'stub', [{ type: 'text', data: { text: 'stub text' } }])
    const childFull = message(11, 101, 'Alice', [{ type: 'text', data: { text: 'full text' } }])
    const calls: string[] = []
    const loader: ForwardLoader = {
      async get_forward_msg(args) {
        calls.push(`forward:${args.message_id}`)
        return { messages: [childStub] }
      },
      async get_msg(args) {
        calls.push(`message:${args.message_id}`)
        return childFull
      },
    }

    const parsed = await forwardParser()(
      message(1, 100, 'outer', [{ type: 'forward', data: { id: 'forward-1' } }]),
      loader,
    )

    assert.deepEqual(calls, ['forward:forward-1', 'message:11'])
    assert.deepEqual(parsed.content, [{
      type: 'forward',
      forwardId: 'forward-1',
      items: [{
        messageId: '11',
        senderId: '101',
        senderName: 'Alice',
        time: 1_700_000_000,
        content: [{ type: 'text', content: 'full text' }],
      }],
    }])
  })

  test('falls back to the forward payload when child get_msg fails', async () => {
    const childStub = message(12, 102, 'Bob', [{ type: 'text', data: { text: 'fallback text' } }])
    const loader: ForwardLoader = {
      async get_forward_msg() {
        return { messages: [childStub] }
      },
      async get_msg() {
        throw new Error('transient failure must not be persisted')
      },
    }

    const parsed = await forwardParser()(
      message(2, 100, 'outer', [{ type: 'forward', data: { id: 'forward-2' } }]),
      loader,
    )

    assert.deepEqual(parsed.content, [{
      type: 'forward',
      forwardId: 'forward-2',
      items: [{
        messageId: '12',
        senderId: '102',
        senderName: 'Bob',
        time: 1_700_000_000,
        content: [{ type: 'text', content: 'fallback text' }],
      }],
    }])
  })

  test('recursively expands nested forwards', async () => {
    const nested = message(21, 201, 'Nested sender', [{ type: 'forward', data: { id: 'nested-forward' } }])
    const leaf = message(22, 202, 'Leaf sender', [{ type: 'text', data: { text: 'leaf' } }])
    const loader: ForwardLoader = {
      async get_forward_msg({ message_id }) {
        return { messages: message_id === 'outer-forward' ? [nested] : [leaf] }
      },
      async get_msg({ message_id }) {
        return message_id === 21 ? nested : leaf
      },
    }

    const parsed = await forwardParser()(
      message(3, 100, 'outer', [{ type: 'forward', data: { id: 'outer-forward' } }]),
      loader,
    )

    const outer = parsed.content[0] as { items: Array<{ content: unknown[] }> }
    const nestedForward = outer.items[0]!.content[0] as { items: Array<{ content: unknown[] }> }
    assert.deepEqual(nestedForward.items[0]!.content, [{ type: 'text', content: 'leaf' }])
  })

  test('marks the segment unavailable without exposing fetch errors', async () => {
    const loader: ForwardLoader = {
      async get_forward_msg() {
        throw new Error('secret upstream detail')
      },
      async get_msg() {
        throw new Error('unexpected')
      },
    }

    const parsed = await forwardParser()(
      message(4, 100, 'outer', [{ type: 'forward', data: { id: 'missing-forward' } }]),
      loader,
    )

    assert.deepEqual(parsed.content, [{
      type: 'forward',
      forwardId: 'missing-forward',
      items: [],
      unavailable: true,
    }])
    assert.doesNotMatch(JSON.stringify(parsed), /secret upstream detail/)
  })

  test('limits a forward tree to fifty child messages', async () => {
    const children = Array.from({ length: 51 }, (_, index) => (
      message(100 + index, 200 + index, `sender-${index}`, [{ type: 'text', data: { text: String(index) } }])
    ))
    let getMessageCalls = 0
    const loader: ForwardLoader = {
      async get_forward_msg() {
        return { messages: children }
      },
      async get_msg({ message_id }) {
        getMessageCalls += 1
        return children.find((child) => child.message_id === message_id)!
      },
    }

    const parsed = await forwardParser()(
      message(5, 100, 'outer', [{ type: 'forward', data: { id: 'large-forward' } }]),
      loader,
    )

    const forward = parsed.content[0] as { items: unknown[]; truncated?: boolean }
    assert.equal(forward.items.length, 50)
    assert.equal(forward.truncated, true)
    assert.equal(getMessageCalls, 50)
  })

  test('truncates forwarded text after two thousand characters', async () => {
    const child = message(31, 301, 'Long sender', [{ type: 'text', data: { text: 'x'.repeat(2_100) } }])
    const loader: ForwardLoader = {
      async get_forward_msg() {
        return { messages: [child] }
      },
      async get_msg() {
        return child
      },
    }

    const parsed = await forwardParser()(
      message(6, 100, 'outer', [{ type: 'forward', data: { id: 'long-forward' } }]),
      loader,
    )

    const forward = parsed.content[0] as {
      truncated?: boolean
      items: Array<{ content: Array<{ type: string; content: string }> }>
    }
    assert.equal(forward.items[0]!.content[0]!.content, `${'x'.repeat(2_000)}…`)
    assert.equal(forward.truncated, true)
  })

  test('stops expanding forwards beyond three nested levels', async () => {
    const chain = new Map<number, NapcatMessage>([
      [41, message(41, 401, 'one', [{ type: 'forward', data: { id: 'level-2' } }])],
      [42, message(42, 402, 'two', [{ type: 'forward', data: { id: 'level-3' } }])],
      [43, message(43, 403, 'three', [{ type: 'forward', data: { id: 'level-4' } }])],
      [44, message(44, 404, 'four', [{ type: 'text', data: { text: 'too deep' } }])],
    ])
    const byForwardId: Record<string, number> = {
      'level-1': 41,
      'level-2': 42,
      'level-3': 43,
      'level-4': 44,
    }
    const requestedForwards: string[] = []
    const loader: ForwardLoader = {
      async get_forward_msg({ message_id }) {
        requestedForwards.push(message_id)
        return { messages: [chain.get(byForwardId[message_id]!)!] }
      },
      async get_msg({ message_id }) {
        return chain.get(message_id)!
      },
    }

    const parsed = await forwardParser()(
      message(7, 100, 'outer', [{ type: 'forward', data: { id: 'level-1' } }]),
      loader,
    )

    let segment = parsed.content[0] as { items: Array<{ content: unknown[] }>; truncated?: boolean }
    segment = segment.items[0]!.content[0] as typeof segment
    segment = segment.items[0]!.content[0] as typeof segment
    segment = segment.items[0]!.content[0] as typeof segment
    assert.deepEqual(segment, { type: 'forward', forwardId: 'level-4', items: [], truncated: true })
    assert.deepEqual(requestedForwards, ['level-1', 'level-2', 'level-3'])
  })
})
