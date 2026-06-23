import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import * as zod from 'zod'
import { appendJournalEntry } from '../journal-store.js'
import { createWriteJournalTool, writeJournalTool } from './write-journal.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function parseContent<T>(content: unknown): T {
  assert.ok(typeof content === 'string')
  return JSON.parse(content) as T
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

  test('accepts read action', () => {
    const r = writeJournalTool.schema.safeParse({
      action: 'read',
      id: 'journal-id',
    })
    assert.equal(r.success, true)
  })

  test('schema serializes cleanly to JSON Schema', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(writeJournalTool.schema))
  })
})

describe('write_journal tool — execute', () => {
  let rootDir: string
  let idCounter: number
  let nowMs: number

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-write-journal-'))
    idCounter = 0
    nowMs = Date.parse('2026-06-23T01:00:00.000Z')
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  function tool() {
    return createWriteJournalTool({
      journalRootDir: rootDir,
      id: () => `entry-${++idCounter}`,
      now: () => new Date((nowMs += 1000)),
    })
  }

  test('old kind/content writes through the workspace store', async () => {
    const result = await tool().execute(
      { kind: 'diary' as const, content: '今天很充实' },
      makeCtx(),
    )
    const parsed = parseContent<{ ok: boolean; id: string; kind: string }>(result.content)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.id, 'entry-1')
    assert.equal(parsed.kind, 'diary')

    const raw = await readFile(join(rootDir, 'journal', 'entries.jsonl'), 'utf8')
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line) as { id: string; content: string })
    assert.deepEqual(rows.map((row) => row.id), ['entry-1'])
    assert.equal(rows[0]!.content, '今天很充实')
  })

  test('action=write returns the new string id', async () => {
    const result = await tool().execute(
      { action: 'write', kind: 'dream' as const, content: '梦里有风' },
      makeCtx(),
    )
    const parsed = parseContent<{ ok: boolean; id: string; kind: string }>(result.content)
    assert.deepEqual(parsed, { ok: true, id: 'entry-1', kind: 'dream' })
  })

  test('action=list reads from workspace files and returns previews', async () => {
    await appendJournalEntry({ rootDir, id: () => 'diary-1', now: () => new Date('2026-06-23T01:00:00.000Z') }, {
      kind: 'diary',
      content: '日记内容',
    })
    await appendJournalEntry({ rootDir, id: () => 'dream-1', now: () => new Date('2026-06-24T01:00:00.000Z') }, {
      kind: 'dream',
      content: '梦境内容',
    })

    const result = await tool().execute(
      { action: 'list', kind: 'dream' as const, limit: 5 },
      makeCtx(),
    )
    const parsed = parseContent<{
      ok: boolean
      action: string
      entries: { id: string; kind: string; createdAt: string; preview: string }[]
    }>(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.action, 'list')
    assert.deepEqual(parsed.entries, [
      {
        id: 'dream-1',
        kind: 'dream',
        createdAt: '2026-06-24T01:00:00.000Z',
        preview: '梦境内容',
      },
    ])
  })

  test('action=search reads from workspace files and returns previews', async () => {
    await appendJournalEntry({ rootDir, id: () => 'match', now: () => new Date('2026-06-24T01:00:00.000Z') }, {
      kind: 'dream',
      content: 'Alpha beta',
    })
    await appendJournalEntry({ rootDir, id: () => 'skip', now: () => new Date('2026-06-25T01:00:00.000Z') }, {
      kind: 'diary',
      content: 'gamma',
    })

    const result = await tool().execute(
      { action: 'search', query: 'ALPHA', limit: 10 },
      makeCtx(),
    )
    const parsed = parseContent<{ ok: boolean; action: string; query: string; entries: { id: string; preview: string }[] }>(
      result.content,
    )

    assert.equal(parsed.ok, true)
    assert.equal(parsed.action, 'search')
    assert.equal(parsed.query, 'ALPHA')
    assert.deepEqual(parsed.entries, [{ id: 'match', kind: 'dream', createdAt: '2026-06-24T01:00:00.000Z', preview: 'Alpha beta' }])
  })

  test('action=read returns full content for one entry', async () => {
    await appendJournalEntry({ rootDir, id: () => 'read-me', now: () => new Date('2026-06-23T01:00:00.000Z') }, {
      kind: 'diary',
      content: '完整内容'.repeat(80),
    })

    const result = await tool().execute({ action: 'read', id: 'read-me' }, makeCtx())
    const parsed = parseContent<{ ok: boolean; entry: { id: string; content: string } }>(result.content)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.entry.id, 'read-me')
    assert.equal(parsed.entry.content, '完整内容'.repeat(80))
  })

  test('unknown read id returns ok:false', async () => {
    const result = await tool().execute({ action: 'read', id: 'missing' }, makeCtx())
    const parsed = parseContent<{ ok: boolean; error: string; id: string }>(result.content)
    assert.deepEqual(parsed, { ok: false, action: 'read', id: 'missing', error: 'journal entry not found' })
  })

  test('previews are truncated to 200 chars', async () => {
    await appendJournalEntry({ rootDir, id: () => 'long', now: () => new Date('2026-06-23T01:00:00.000Z') }, {
      kind: 'diary',
      content: 'x'.repeat(240),
    })

    const result = await tool().execute({ action: 'list', limit: 1 }, makeCtx())
    const parsed = parseContent<{ ok: boolean; entries: { id: string; preview: string }[] }>(result.content)
    assert.equal(parsed.entries[0]!.id, 'long')
    assert.equal(parsed.entries[0]!.preview, `${'x'.repeat(200)}…`)
  })
})
