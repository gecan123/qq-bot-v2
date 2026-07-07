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
})
