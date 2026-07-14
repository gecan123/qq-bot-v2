import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createLifeJournalTool } from './life-journal.js'

describe('life_journal tool', () => {
  test('rate-limits successful reflection writes but leaves dream writes available', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-life-journal-cooldown-'))
    let nowMs = Date.parse('2026-07-07T15:18:00.000Z')
    let nextId = 0
    try {
      const tool = createLifeJournalTool({
        rootDir,
        now: () => new Date(nowMs),
        id: () => `cooldown-${++nextId}`,
      })

      const first = JSON.parse((await tool.execute({
        action: 'write',
        markdown: '第一条反思',
      }, undefined as never)).content as string) as { ok: boolean }
      const blocked = JSON.parse((await tool.execute({
        action: 'write',
        markdown: '重复收尾',
      }, undefined as never)).content as string) as { ok: boolean; code: string; retryAfterMs: number }
      const dream = JSON.parse((await tool.execute({
        action: 'write',
        kind: 'dream',
        markdown: '一个梦',
      }, undefined as never)).content as string) as { ok: boolean }
      nowMs += 15 * 60_000
      const afterCooldown = JSON.parse((await tool.execute({
        action: 'write',
        markdown: '十五分钟后的新反思',
      }, undefined as never)).content as string) as { ok: boolean }

      assert.equal(first.ok, true)
      assert.deepEqual(
        { ok: blocked.ok, code: blocked.code, retryAfterMs: blocked.retryAfterMs },
        { ok: false, code: 'reflection_write_cooldown', retryAfterMs: 15 * 60_000 },
      )
      assert.equal(dream.ok, true)
      assert.equal(afterCooldown.ok, true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('lets the main agent actively write journal notes and manage agenda', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-life-journal-tool-'))
    try {
      const tool = createLifeJournalTool({
        rootDir,
        now: () => new Date('2026-07-07T15:18:00.000Z'),
        id: () => 'manual-entry',
      })

      assert.equal(tool.name, 'life_journal')

      const written = JSON.parse((await tool.execute({
        action: 'write',
        kind: 'dream',
        markdown: '### Saw\n- 我主动决定记下这个线索。\n',
      }, undefined as never)).content as string) as {
        ok: boolean
        path: string
        heading: string
        entryId: string
        kind: string
      }
      const recent = JSON.parse((await tool.execute({
        action: 'read_recent',
        days: 1,
      }, undefined as never)).content as string) as {
        files: Array<{ path: string; date: string; content: string; revision: string }>
      }
      const day = JSON.parse((await tool.execute({
        action: 'read_day',
        date: recent.files[0]!.date,
        maxChars: 500,
      }, undefined as never)).content as string) as { ok: boolean; content: string; revision: string }
      const entry = JSON.parse((await tool.execute({
        action: 'read_entry',
        date: recent.files[0]!.date,
        entryId: written.entryId,
      }, undefined as never)).content as string) as { ok: boolean; entry: { markdown: string } }
      const agendaBefore = JSON.parse((await tool.execute({
        action: 'read_agenda',
      }, undefined as never)).content as string) as { markdown: string; revision: string }
      const agendaWritten = JSON.parse((await tool.execute({
        action: 'write_agenda',
        expectedRevision: agendaBefore.revision,
        markdown: '# Agenda\n\n## Active\n- [ ] 继续验证主动 journal\n\n## Waiting\n\n## Someday\n\n## Done\n',
      }, undefined as never)).content as string) as { ok: boolean; path: string }
      const agenda = JSON.parse((await tool.execute({
        action: 'read_agenda',
      }, undefined as never)).content as string) as { markdown: string }

      assert.equal(written.ok, true)
      assert.equal(written.heading, '## 23:18 Manual')
      assert.equal(written.entryId, 'manual-entry')
      assert.equal(written.kind, 'dream')
      assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /我主动决定/)
      assert.equal(recent.files.length, 1)
      assert.equal(recent.files[0]?.content.includes('我主动决定'), true)
      assert.equal(day.ok, true)
      assert.match(day.content, /我主动决定/)
      assert.equal(entry.ok, true)
      assert.match(entry.entry.markdown, /我主动决定/)
      assert.equal(agendaWritten.ok, true)
      assert.match(agenda.markdown, /继续验证主动 journal/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('updates, deletes, and compacts journal entries with the latest revision', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-life-journal-tool-mutate-'))
    let nextId = 0
    try {
      const tool = createLifeJournalTool({
        rootDir,
        now: () => new Date('2026-07-07T15:18:00.000Z'),
        id: () => `entry-${++nextId}`,
        reflectionWriteMinIntervalMs: 0,
      })
      for (const markdown of ['wrong', 'duplicate', 'keep']) {
        await tool.execute({ action: 'write', markdown }, undefined as never)
      }
      const read = async () => JSON.parse((await tool.execute({
        action: 'read_recent',
        days: 1,
      }, undefined as never)).content as string) as {
        files: Array<{ date: string; revision: string; entries: Array<{ entryId: string }> }>
      }

      let file = (await read()).files[0]!
      const updated = JSON.parse((await tool.execute({
        action: 'update',
        date: file.date,
        entryId: 'entry-1',
        expectedRevision: file.revision,
        markdown: 'corrected',
      }, undefined as never)).content as string) as { ok: boolean; revision: string }
      assert.equal(updated.ok, true)

      const staleDelete = JSON.parse((await tool.execute({
        action: 'delete',
        date: file.date,
        entryId: 'entry-2',
        expectedRevision: file.revision,
      }, undefined as never)).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: staleDelete.ok, code: staleDelete.code }, { ok: false, code: 'revision_conflict' })

      file = (await read()).files[0]!
      const compacted = JSON.parse((await tool.execute({
        action: 'compact',
        date: file.date,
        entryIds: ['entry-1', 'entry-2'],
        expectedRevision: file.revision,
        markdown: 'one compact note',
      }, undefined as never)).content as string) as { ok: boolean; entryId: string }
      assert.equal(compacted.ok, true)
      assert.equal(compacted.entryId, 'entry-4')

      file = (await read()).files[0]!
      const deleted = JSON.parse((await tool.execute({
        action: 'delete',
        date: file.date,
        entryId: 'entry-3',
        expectedRevision: file.revision,
      }, undefined as never)).content as string) as { ok: boolean }
      assert.equal(deleted.ok, true)
      const raw = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
      assert.match(raw, /one compact note/)
      assert.doesNotMatch(raw, /wrong|duplicate|keep/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
