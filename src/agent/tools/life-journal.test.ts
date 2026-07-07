import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createLifeJournalTool } from './life-journal.js'

describe('life_journal tool', () => {
  test('lets the main agent actively write journal notes and manage agenda', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-life-journal-tool-'))
    try {
      const tool = createLifeJournalTool({
        rootDir,
        now: () => new Date('2026-07-07T15:18:00.000Z'),
      })

      assert.equal(tool.name, 'life_journal')

      const written = JSON.parse((await tool.execute({
        action: 'write',
        markdown: '### Saw\n- 我主动决定记下这个线索。\n',
      }, undefined as never)).content as string) as { ok: boolean; path: string; heading: string }
      const recent = JSON.parse((await tool.execute({
        action: 'read_recent',
        days: 1,
      }, undefined as never)).content as string) as { files: Array<{ path: string; content: string }> }
      const agendaWritten = JSON.parse((await tool.execute({
        action: 'write_agenda',
        markdown: '# Agenda\n\n## Active\n- [ ] 继续验证主动 journal\n\n## Waiting\n\n## Someday\n\n## Done\n',
      }, undefined as never)).content as string) as { ok: boolean; path: string }
      const agenda = JSON.parse((await tool.execute({
        action: 'read_agenda',
      }, undefined as never)).content as string) as { markdown: string }

      assert.equal(written.ok, true)
      assert.equal(written.heading, '## 23:18 Manual')
      assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /我主动决定/)
      assert.equal(recent.files.length, 1)
      assert.equal(recent.files[0]?.content.includes('我主动决定'), true)
      assert.equal(agendaWritten.ok, true)
      assert.match(agenda.markdown, /继续验证主动 journal/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
