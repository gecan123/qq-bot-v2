import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSendMessageTool } from './send-message.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { SendNapcatResult } from '../../messaging/napcat-sender.js'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

interface RecordedCall {
  fn: 'replyToMessage' | 'sendGroupMessage' | 'sendPrivateMessage'
  args: unknown
}

function makeMockSender(result: SendNapcatResult = { success: true, attempts: 1, providerMessageId: 8888 }): {
  sender: MessageSender
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const sender: MessageSender = {
    async replyToMessage(args) {
      calls.push({ fn: 'replyToMessage', args })
      return result
    },
    async sendGroupMessage(args) {
      calls.push({ fn: 'sendGroupMessage', args })
      return result
    },
    async sendPrivateMessage(args) {
      calls.push({ fn: 'sendPrivateMessage', args })
      return result
    },
  }
  return { sender, calls }
}

function parseToolResult(content: string): {
  ok: boolean
  attempts: number
  providerMessageId: number | null
  kind: string
  error?: string
} {
  return JSON.parse(content)
}

describe('send_message tool — group target', () => {
  test('group reply (replyToMessageId set) → sender.replyToMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111, 222] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 555,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-reply')
    assert.equal(result.providerMessageId, 8888)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'replyToMessage')
  })

  test('group ambient (no replyToMessageId) → sender.sendGroupMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.kind, 'group-ambient')
    assert.equal(calls[0]!.fn, 'sendGroupMessage')
  })

  test('group target outside whitelist → ok=false, no actual send', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 999 },
        text: 'spam',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /not in BOT_TARGET_GROUP_IDS whitelist/)
    assert.equal(calls.length, 0, 'must not call any sender method')
  })

  test('group reply with mentionUserId is forwarded to replyToMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    await tool.execute(
      {
        target: { type: 'group', groupId: 111, mentionUserId: 100 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const args = calls[0]!.args as { mentionUserId?: number }
    assert.equal(args.mentionUserId, 100)
  })

  test('group ambient with groupAmbientDryRun=true → ok=true 但不调用 sender (dry-run)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: true, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: '主动开个话题',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true, 'LLM 看到的是假成功')
    assert.equal(result.kind, 'group-ambient')
    assert.equal(result.providerMessageId, null, 'dry-run 没有真 providerMessageId')
    assert.equal(calls.length, 0, 'dry-run 不能调用任何 sender 方法')
  })

  test('group ambient with groupAmbientDryRun=true 仍然受白名单约束', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: true, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 999 },
        text: 'spam',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, false, '白名单校验在 dry-run 之前, 越界仍然 ok=false')
    assert.match(result.error ?? '', /not in BOT_TARGET_GROUP_IDS whitelist/)
    assert.equal(calls.length, 0)
  })

  test('group reply with groupAmbientDryRun=true 仍然真发 (dry-run 只覆盖 ambient)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: true, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-reply')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'replyToMessage', 'reply 路径不受 dry-run 影响, 真发')
  })

  test('group send failure → ok=false, error set', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2, providerMessageId: undefined })
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.equal(result.attempts, 2)
    assert.equal(result.providerMessageId, null)
    assert.match(result.error ?? '', /failed/i)
  })
})

describe('send_message tool — private target', () => {
  test('private reply → sender.sendPrivateMessage with replyToMessageId', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [] })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        text: 'hi',
        replyToMessageId: 333,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'private-reply')
    assert.equal(calls[0]!.fn, 'sendPrivateMessage')
    const args = calls[0]!.args as { userId: number; text: string; replyToMessageId?: number }
    assert.equal(args.userId, 10001)
    assert.equal(args.replyToMessageId, 333)
  })

  test('private ambient (no replyToMessageId) → sender.sendPrivateMessage without reply', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [] })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        text: '主动开个话题',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.kind, 'private-ambient')
    const args = calls[0]!.args as { replyToMessageId?: number }
    assert.equal(args.replyToMessageId, undefined)
  })

  test('private target with arbitrary userId → 仍然真发 (private 不走白名单)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [] })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 99999 },
        text: 'hello',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'private-ambient')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendPrivateMessage')
    const args = calls[0]!.args as { userId: number }
    assert.equal(args.userId, 99999)
  })
})

describe('send_message tool — schema rejection', () => {
  test('rejects mentionUserId on private target via Zod (private branch has no mentionUserId)', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [] })
    // safeParse via tool.schema
    const r = tool.schema.safeParse({
      target: { type: 'private', userId: 10001, mentionUserId: 1 },
      text: 'hi',
    })
    // mentionUserId is silently ignored by zod union (extra prop), but the discriminated branch
    // doesn't carry it through. Verify that target.mentionUserId is not on the parsed shape.
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as { target: { type: string; userId?: number; mentionUserId?: number } }
      assert.equal(data.target.type, 'private')
      assert.equal('mentionUserId' in data.target, false)
    }
  })

  test('rejects text > 500 chars via Zod', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      text: 'x'.repeat(501),
    })
    assert.equal(r.success, false)
  })

  test('accepts the historical name "send_group_message" is NOT this tool', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientDryRun: false, groupIdWhitelist: [111] })
    assert.equal(tool.name, 'send_message')
  })
})
