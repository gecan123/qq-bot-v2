import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createJournalTool } from './journal.js'

describe('journal tool', () => {
  test('writes, lists, searches, and reads journal entries with bounded previews', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-journal-tool-'))
    try {
      const tool = createJournalTool({
        rootDir,
        now: () => new Date('2026-07-07T01:02:03.000Z'),
        id: () => 'entry-1',
      })

      assert.equal(tool.name, 'journal')

      const written = JSON.parse((await tool.execute({
        action: 'write',
        kind: 'diary',
        content: '今天研究了工具拆分。',
      }, undefined as never)).content as string) as { ok: boolean; id: string; kind: string }
      const listed = JSON.parse((await tool.execute({
        action: 'list',
        kind: 'diary',
      }, undefined as never)).content as string) as { entries: Array<{ id: string; preview: string }> }
      const searched = JSON.parse((await tool.execute({
        action: 'search',
        query: '工具',
      }, undefined as never)).content as string) as { entries: Array<{ id: string }> }
      const read = JSON.parse((await tool.execute({
        action: 'read',
        id: 'entry-1',
      }, undefined as never)).content as string) as { entry?: { content: string } }

      assert.equal(written.ok, true)
      assert.equal(written.id, 'entry-1')
      assert.equal(written.kind, 'diary')
      assert.equal(listed.entries[0]?.id, 'entry-1')
      assert.equal(listed.entries[0]?.preview, '今天研究了工具拆分。')
      assert.equal(searched.entries[0]?.id, 'entry-1')
      assert.equal(read.entry?.content, '今天研究了工具拆分。')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('updates, deletes, and compacts entries through the typed tool', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-journal-tool-mutate-'))
    let nextId = 0
    try {
      const tool = createJournalTool({
        rootDir,
        now: () => new Date('2026-07-07T01:02:03.000Z'),
        id: () => `entry-${++nextId}`,
      })
      for (const content of ['wrong', 'duplicate', 'keep']) {
        await tool.execute({ action: 'write', kind: 'diary', content }, undefined as never)
      }
      const read = async (id: string) => JSON.parse((await tool.execute({
        action: 'read',
        id,
      }, undefined as never)).content as string) as { ok: boolean; revision: string }

      let snapshot = await read('entry-1')
      const updated = JSON.parse((await tool.execute({
        action: 'update',
        id: 'entry-1',
        expectedRevision: snapshot.revision,
        content: 'corrected',
      }, undefined as never)).content as string) as { ok: boolean }
      assert.equal(updated.ok, true)

      snapshot = await read('entry-1')
      const compacted = JSON.parse((await tool.execute({
        action: 'compact',
        ids: ['entry-1', 'entry-2'],
        expectedRevision: snapshot.revision,
        content: 'combined',
      }, undefined as never)).content as string) as { ok: boolean; entry: { id: string } }
      assert.equal(compacted.ok, true)
      assert.equal(compacted.entry.id, 'entry-4')

      snapshot = await read('entry-3')
      const deleted = JSON.parse((await tool.execute({
        action: 'delete',
        id: 'entry-3',
        expectedRevision: snapshot.revision,
      }, undefined as never)).content as string) as { ok: boolean }
      assert.equal(deleted.ok, true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
