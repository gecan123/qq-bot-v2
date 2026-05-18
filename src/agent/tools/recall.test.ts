import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import * as zod from 'zod'
import { recallTool } from './recall.js'
import { prisma } from '../../database/client.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

interface CapturedFindMany {
  where?: {
    targetKind?: string
    targetId?: string
    content?: { contains?: string; mode?: string }
  }
  orderBy?: { createdAt?: string }
  take?: number
  select?: Record<string, boolean>
}

interface MockRow {
  content: string
  createdAt: Date
}

describe('recall tool — schema', () => {
  // schema 保持 union (string | number) 不 transform — Anthropic tool decl 走 zod.toJSONSchema,
  // transform 不能序列化. 字符串化在 execute() 里做.
  test('accepts numeric id (kept as number by schema)', () => {
    const r = recallTool.schema.safeParse({
      target: { kind: 'person', id: 100 },
    })
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as { target: { id: unknown } }
      assert.equal(data.target.id, 100)
    }
  })

  test('limit above 20 rejected', () => {
    const r = recallTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      limit: 21,
    })
    assert.equal(r.success, false)
  })

  test('limit below 1 rejected', () => {
    const r = recallTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      limit: 0,
    })
    assert.equal(r.success, false)
  })

  test('keyword optional', () => {
    const r = recallTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
    })
    assert.equal(r.success, true)
  })

  test('empty keyword (whitespace only) rejected after trim', () => {
    const r = recallTool.schema.safeParse({
      target: { kind: 'person', id: 1 },
      keyword: '   ',
    })
    assert.equal(r.success, false)
  })

  test('schema serializes cleanly to JSON Schema (regression: zod.transform broke Anthropic tool decl)', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(recallTool.schema))
  })
})

describe('recall tool — execute', () => {
  let captured: CapturedFindMany | null
  let mockResults: MockRow[]
  let originalFindMany: typeof prisma.memoryEntry.findMany

  beforeEach(() => {
    captured = null
    mockResults = []
    originalFindMany = prisma.memoryEntry.findMany
    prisma.memoryEntry.findMany = ((args: CapturedFindMany) => {
      captured = args
      return Promise.resolve(mockResults)
    }) as never
  })

  afterEach(() => {
    prisma.memoryEntry.findMany = originalFindMany
  })

  test('empty results returns entries:[] with hint', async () => {
    mockResults = []
    const result = await recallTool.execute(
      { target: { kind: 'person', id: '999' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as {
      entries: unknown[]
      hint?: string
    }
    assert.deepEqual(parsed.entries, [])
    assert.ok(parsed.hint, 'empty result should include hint')
    assert.match(parsed.hint!, /没有关于这个 person/)
  })

  test('empty results with keyword mentions keyword in hint', async () => {
    mockResults = []
    const result = await recallTool.execute(
      { target: { kind: 'group', id: '888' }, keyword: '日本' },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { hint?: string }
    assert.match(parsed.hint!, /日本/)
  })

  test('returns entries with content + when ISO, no sourceMessageIds', async () => {
    const now = new Date('2026-05-16T03:00:00.000Z')
    mockResults = [
      { content: '想去日本', createdAt: now },
      { content: '吃辣不行', createdAt: new Date('2026-05-15T03:00:00.000Z') },
    ]
    const result = await recallTool.execute(
      { target: { kind: 'person', id: '12345' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as {
      entries: { content: string; when: string }[]
    }
    assert.equal(parsed.entries.length, 2)
    assert.equal(parsed.entries[0]!.content, '想去日本')
    assert.equal(parsed.entries[0]!.when, '2026-05-16T03:00:00.000Z')
    assert.equal('sourceMessageIds' in parsed.entries[0]!, false)
  })

  test('keyword translates to case-insensitive contains filter', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' }, keyword: '日本' },
      makeCtx(),
    )
    assert.equal(captured!.where!.content!.contains, '日本')
    assert.equal(captured!.where!.content!.mode, 'insensitive')
  })

  test('no keyword → no content filter in where clause', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' } },
      makeCtx(),
    )
    assert.equal(captured!.where!.content, undefined)
  })

  test('target filter applied', async () => {
    await recallTool.execute(
      { target: { kind: 'group', id: '888' } },
      makeCtx(),
    )
    assert.equal(captured!.where!.targetKind, 'group')
    assert.equal(captured!.where!.targetId, '888')
  })

  test('numeric target.id stringified before query', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: 12345 } },
      makeCtx(),
    )
    assert.equal(captured!.where!.targetId, '12345')
    assert.equal(typeof captured!.where!.targetId, 'string')
  })

  test('default limit is 10', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' } },
      makeCtx(),
    )
    assert.equal(captured!.take, 10)
  })

  test('custom limit honored', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' }, limit: 5 },
      makeCtx(),
    )
    assert.equal(captured!.take, 5)
  })

  test('orderBy createdAt desc', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' } },
      makeCtx(),
    )
    assert.equal(captured!.orderBy!.createdAt, 'desc')
  })

  test('select only content + createdAt (sourceMessageIds not selected)', async () => {
    await recallTool.execute(
      { target: { kind: 'person', id: '1' } },
      makeCtx(),
    )
    assert.equal(captured!.select!.content, true)
    assert.equal(captured!.select!.createdAt, true)
    assert.equal(captured!.select!.sourceMessageIds, undefined)
  })
})
