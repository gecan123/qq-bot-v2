import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import * as zod from 'zod'
import { rememberTool } from './remember.js'
import { prisma } from '../../database/client.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

interface CapturedCreate {
  data: {
    targetKind: string
    targetId: string
    content: string
    sourceMessageIds?: unknown
  }
  select?: Record<string, boolean>
}

describe('remember tool — schema', () => {
  // schema 保持 union (string | number) 不 transform — Anthropic tool decl 走 zod.toJSONSchema,
  // transform 不能序列化. 字符串化在 execute() 里做.
  test('accepts numeric id (kept as number by schema)', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'person', id: 100200300 },
      content: 'hi',
    })
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as { target: { id: unknown } }
      assert.equal(data.target.id, 100200300)
    }
  })

  test('accepts string id and keeps it as string', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'group', id: '999' },
      content: 'hi',
    })
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as { target: { id: unknown } }
      assert.equal(data.target.id, '999')
    }
  })

  test('rejects content longer than 500 chars', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      content: 'x'.repeat(501),
    })
    assert.equal(r.success, false)
  })

  test('rejects empty content', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      content: '',
    })
    assert.equal(r.success, false)
  })

  test('rejects invalid kind', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'org', id: 1 },
      content: 'hi',
    })
    assert.equal(r.success, false)
  })

  test('accepts optional sourceMessageIds', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      content: 'hi',
      sourceMessageIds: [10, 20, 30],
    })
    assert.equal(r.success, true)
  })

  test('rejects non-integer sourceMessageIds', () => {
    const r = rememberTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      content: 'hi',
      sourceMessageIds: [1.5],
    })
    assert.equal(r.success, false)
  })

  test('schema serializes cleanly to JSON Schema (regression: zod.transform broke Anthropic tool decl)', () => {
    // 这条挡 zod.transform — 之前 id 用 .transform(String) 导致
    // 'Transforms cannot be represented in JSON Schema' 整个 round 起不来.
    assert.doesNotThrow(() => zod.toJSONSchema(rememberTool.schema))
  })
})

describe('remember tool — execute', () => {
  let captured: CapturedCreate | null
  let originalCreate: typeof prisma.memoryEntry.create

  beforeEach(() => {
    captured = null
    originalCreate = prisma.memoryEntry.create
    prisma.memoryEntry.create = ((args: CapturedCreate) => {
      captured = args
      return Promise.resolve({ id: 42 })
    }) as never
  })

  afterEach(() => {
    prisma.memoryEntry.create = originalCreate
  })

  test('writes row with correct fields and returns ok:true with id', async () => {
    const result = await rememberTool.execute(
      {
        target: { kind: 'person', id: '12345' },
        content: '想去日本',
      },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { ok: boolean; id: number }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.id, 42)
    assert.ok(captured, 'create should have been called')
    assert.equal(captured!.data.targetKind, 'person')
    assert.equal(captured!.data.targetId, '12345')
    assert.equal(captured!.data.content, '想去日本')
    assert.equal(captured!.data.sourceMessageIds, undefined)
  })

  test('numeric target.id stringified to targetId before write', async () => {
    await rememberTool.execute(
      {
        target: { kind: 'person', id: 100200300 },
        content: 'hi',
      },
      makeCtx(),
    )
    assert.equal(captured!.data.targetId, '100200300')
    assert.equal(typeof captured!.data.targetId, 'string')
  })

  test('group target writes targetKind=group', async () => {
    await rememberTool.execute(
      {
        target: { kind: 'group', id: '888' },
        content: '群里最近聊旅游',
      },
      makeCtx(),
    )
    assert.equal(captured!.data.targetKind, 'group')
    assert.equal(captured!.data.targetId, '888')
  })

  test('passes sourceMessageIds when provided', async () => {
    await rememberTool.execute(
      {
        target: { kind: 'person', id: '1' },
        content: 'note',
        sourceMessageIds: [101, 102],
      },
      makeCtx(),
    )
    assert.deepEqual(captured!.data.sourceMessageIds, [101, 102])
  })
})
