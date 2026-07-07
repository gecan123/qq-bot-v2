import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  appendLifeJournalEntry,
  ensureLifeAgenda,
  readLifeAgenda,
  readRecentLifeJournalFiles,
  writeLifeAgenda,
} from './life-journal-store.js'

describe('life journal markdown store', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'life-journal-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('appends daily journal entries under life/journal', async () => {
    const result = await appendLifeJournalEntry({
      rootDir,
      now: () => new Date('2026-07-07T15:18:00.000Z'),
      roundIndex: 42,
      markdown: '### Saw\n- 用户确认方向。\n',
    })

    const raw = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
    assert.match(raw, /# Life Journal 2026-07-07/)
    assert.match(raw, /## 23:18 Round 42/)
    assert.match(raw, /### Saw\n- 用户确认方向。/)
    assert.equal(result.path, join(rootDir, 'life', 'journal', '2026-07-07.md'))
    assert.equal(result.heading, '## 23:18 Round 42')
  })

  test('ensureLifeAgenda creates life agenda from a fixed template', async () => {
    const agendaPath = await ensureLifeAgenda({ rootDir })
    const raw = await readFile(agendaPath, 'utf8')

    assert.equal(agendaPath, join(rootDir, 'life', 'agenda.md'))
    assert.match(raw, /^# Agenda/)
    assert.match(raw, /## Active/)
    assert.match(raw, /## Waiting/)
    assert.match(raw, /## Someday/)
    assert.match(raw, /## Done/)
  })

  test('writeLifeAgenda overwrites only life agenda', async () => {
    await mkdir(join(rootDir, 'life'), { recursive: true })
    await writeFile(join(rootDir, 'life', 'other.md'), 'keep me', 'utf8')

    await writeLifeAgenda({ rootDir }, '# Agenda\n\n## Active\n- [ ] 新计划\n')

    assert.equal(await readLifeAgenda({ rootDir }), '# Agenda\n\n## Active\n- [ ] 新计划\n')
    assert.equal(await readFile(join(rootDir, 'life', 'other.md'), 'utf8'), 'keep me')
  })

  test('readRecentLifeJournalFiles returns at most latest daily files', async () => {
    await mkdir(join(rootDir, 'life', 'journal'), { recursive: true })
    await writeFile(join(rootDir, 'life', 'journal', '2026-07-05.md'), 'old', 'utf8')
    await writeFile(join(rootDir, 'life', 'journal', '2026-07-06.md'), 'middle', 'utf8')
    await writeFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'latest', 'utf8')
    await writeFile(join(rootDir, 'life', 'journal', 'notes.txt'), 'ignored', 'utf8')

    const files = await readRecentLifeJournalFiles({ rootDir, days: 2 })

    assert.deepEqual(
      files.map((file) => file.path),
      [
        join(rootDir, 'life', 'journal', '2026-07-07.md'),
        join(rootDir, 'life', 'journal', '2026-07-06.md'),
      ],
    )
    assert.deepEqual(
      files.map((file) => file.content),
      ['latest', 'middle'],
    )
  })

  test('path helpers never accept caller-provided paths', async () => {
    await appendLifeJournalEntry({
      rootDir,
      now: () => new Date('2026-07-07T15:18:00.000Z'),
      roundIndex: 1,
      markdown: '../../escape\n',
    })
    await writeLifeAgenda({ rootDir }, '../outside\n')

    assert.equal(
      await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8').then((raw) =>
        raw.includes('../../escape'),
      ),
      true,
    )
    assert.equal(await readLifeAgenda({ rootDir }), '../outside\n')
  })
})
