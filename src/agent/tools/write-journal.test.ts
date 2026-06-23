import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import * as zod from 'zod'
import { writeJournalTool } from './write-journal.js'
import { prisma } from '../../database/client.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

interface CapturedCreate {
  data: {
    kind: string
    content: string
  }
  select?: Record<string, boolean>
}

interface CapturedFindMany {
  where?: Record<string, unknown>
  orderBy?: unknown
  take?: number
  select?: Record<string, boolean>
}

describe('write_journal tool — schema', () => {
  test('accepts diary kind', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'diary',
      content: '今天群里聊了半天旅游',
    })
    assert.equal(r.success, true)
  })

  test('accepts dream kind', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'dream',
      content: '梦到在海底走路',
    })
    assert.equal(r.success, true)
  })

  test('rejects invalid kind', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'note',
      content: 'hi',
    })
    assert.equal(r.success, false)
  })

  test('rejects empty content', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'diary',
      content: '',
    })
    assert.equal(r.success, false)
  })

  test('rejects content longer than 2000 chars', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'diary',
      content: 'x'.repeat(2001),
    })
    assert.equal(r.success, false)
  })

  test('accepts content at exactly 2000 chars', () => {
    const r = writeJournalTool.schema.safeParse({
      kind: 'dream',
      content: 'x'.repeat(2000),
    })
    assert.equal(r.success, true)
  })

  test('schema serializes cleanly to JSON Schema', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(writeJournalTool.schema))
  })
})

describe('write_journal tool — execute', () => {
  let captured: CapturedCreate | null
  let originalCreate: typeof prisma.journalEntry.create
  let originalFindMany: typeof prisma.journalEntry.findMany
  let capturedFindMany: CapturedFindMany | null

  beforeEach(() => {
    captured = null
    capturedFindMany = null
    originalCreate = prisma.journalEntry.create
    originalFindMany = prisma.journalEntry.findMany
    prisma.journalEntry.create = ((args: CapturedCreate) => {
      captured = args
      return Promise.resolve({ id: 7 })
    }) as never
    prisma.journalEntry.findMany = ((args: CapturedFindMany) => {
      capturedFindMany = args
      return Promise.resolve([
        {
          id: 2,
          kind: 'dream',
          content: '梦到关键词' + 'x'.repeat(240),
          createdAt: new Date('2026-06-23T01:00:00.000Z'),
        },
        {
          id: 1,
          kind: 'diary',
          content: '短内容',
          createdAt: new Date('2026-06-22T01:00:00.000Z'),
        },
      ])
    }) as never
  })

  afterEach(() => {
    prisma.journalEntry.create = originalCreate
    prisma.journalEntry.findMany = originalFindMany
  })

  test('writes diary entry and returns ok:true with id and kind', async () => {
    const result = await writeJournalTool.execute(
      { kind: 'diary' as const, content: '今天很充实' },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { ok: boolean; id: number; kind: string }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.id, 7)
    assert.equal(parsed.kind, 'diary')
    assert.ok(captured, 'create should have been called')
    assert.equal(captured!.data.kind, 'diary')
    assert.equal(captured!.data.content, '今天很充实')
  })

  test('writes dream entry with correct kind', async () => {
    const result = await writeJournalTool.execute(
      { kind: 'dream' as const, content: '在云上飘' },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { ok: boolean; id: number; kind: string }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.kind, 'dream')
    assert.equal(captured!.data.kind, 'dream')
    assert.equal(captured!.data.content, '在云上飘')
  })

  test('new action=write writes dream entry', async () => {
    const result = await writeJournalTool.execute(
      { action: 'write', kind: 'dream' as const, content: '梦里有风' },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { ok: boolean; id: number; kind: string }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.id, 7)
    assert.equal(parsed.kind, 'dream')
    assert.equal(captured!.data.kind, 'dream')
    assert.equal(captured!.data.content, '梦里有风')
  })

  test('action=list returns bounded recent entries for kind', async () => {
    const result = await writeJournalTool.execute(
      { action: 'list', kind: 'dream' as const, limit: 5 },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as {
      ok: boolean
      entries: { id: number; kind: string; createdAt: string; preview: string }[]
    }

    assert.equal(parsed.ok, true)
    assert.equal(parsed.entries.length, 2)
    assert.equal(parsed.entries[0]!.id, 2)
    assert.equal(parsed.entries[0]!.kind, 'dream')
    assert.equal(parsed.entries[0]!.preview.length <= 201, true)
    assert.ok(parsed.entries[0]!.preview.endsWith('…'))
    assert.deepEqual(capturedFindMany?.where, { kind: 'dream' })
    assert.equal(capturedFindMany?.take, 5)
    assert.deepEqual(capturedFindMany?.orderBy, { createdAt: 'desc' })
  })

  test('action=search queries keyword and caps limit at 20', async () => {
    const result = await writeJournalTool.execute(
      { action: 'search', query: '关键词', limit: 99 },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string) as { ok: boolean; entries: unknown[] }

    assert.equal(parsed.ok, true)
    assert.equal(capturedFindMany?.take, 20)
    assert.deepEqual(capturedFindMany?.where, { content: { contains: '关键词', mode: 'insensitive' } })
  })
})
