import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  appendLifeJournalEntry,
  compactLifeJournalEntries,
  deleteLifeJournalEntry,
  ensureLifeAgenda,
  LifeJournalStoreError,
  readLifeAgenda,
  readLifeAgendaSnapshot,
  readLifeJournalDay,
  readLifeJournalEntry,
  readRecentLifeJournalFiles,
  updateLifeJournalEntry,
  writeLifeAgenda,
  writeLifeAgendaIfRevision,
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
      id: () => 'entry-round-42',
      roundIndex: 42,
      markdown: '### Saw\n- 用户确认方向。\n',
    })

    const raw = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
    assert.match(raw, /# Life Journal 2026-07-07/)
    assert.match(raw, /## 23:18 Round 42/)
    assert.match(raw, /id: entry-round-42/)
    assert.match(raw, /### Saw\n- 用户确认方向。/)
    assert.equal(result.path, join(rootDir, 'life', 'journal', '2026-07-07.md'))
    assert.equal(result.heading, '## 23:18 Round 42')
    assert.equal(result.entryId, 'entry-round-42')
    const day = await readLifeJournalDay({ rootDir, date: '2026-07-07' })
    const entry = await readLifeJournalEntry({ rootDir, date: '2026-07-07', entryId: result.entryId })
    assert.equal(day.entries[0]?.id, result.entryId)
    assert.match(entry.entry.markdown, /用户确认方向/)
  })

  test('rejects old day files and replaces them on the next write', async () => {
    await mkdir(join(rootDir, 'life', 'journal'), { recursive: true })
    await writeFile(
      join(rootDir, 'life', 'journal', '2026-07-07.md'),
      '# Life Journal 2026-07-07\n\n## 10:00 Round 1\n\nold fact\n\n## 10:10 Manual\n\nkeep me\n',
      'utf8',
    )

    await assert.rejects(
      readLifeJournalDay({ rootDir, date: '2026-07-07' }),
      (error: unknown) => error instanceof LifeJournalStoreError && error.code === 'invalid_format',
    )
    assert.deepEqual(await readRecentLifeJournalFiles({ rootDir, days: 1 }), [])

    await appendLifeJournalEntry({
      rootDir,
      now: () => new Date('2026-07-07T02:30:00.000Z'),
      id: () => 'new-entry',
      markdown: 'new format only',
    })

    const raw = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
    assert.match(raw, /life-journal-format: 1/)
    assert.match(raw, /<!-- life-journal-entry/)
    assert.match(raw, /new format only/)
    assert.doesNotMatch(raw, /old fact/)
    assert.doesNotMatch(raw, /keep me/)
  })

  test('deletes one entry and rejects a stale revision', async () => {
    const first = await appendLifeJournalEntry({
      rootDir,
      now: () => new Date('2026-07-07T15:18:00.000Z'),
      id: () => 'delete-me',
      markdown: 'wrong',
    })
    await appendLifeJournalEntry({
      rootDir,
      now: () => new Date('2026-07-07T15:19:00.000Z'),
      id: () => 'keep-me',
      markdown: 'right',
    })
    const [before] = await readRecentLifeJournalFiles({ rootDir, days: 1 })

    const deleted = await deleteLifeJournalEntry({
      rootDir,
      date: '2026-07-07',
      entryId: first.entryId,
      expectedRevision: before!.revision,
    })
    const raw = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
    assert.doesNotMatch(raw, /wrong/)
    assert.match(raw, /right/)

    await assert.rejects(
      deleteLifeJournalEntry({
        rootDir,
        date: '2026-07-07',
        entryId: 'keep-me',
        expectedRevision: before!.revision,
      }),
      (error: unknown) => error instanceof LifeJournalStoreError && error.code === 'revision_conflict',
    )
    assert.notEqual(deleted.revision, before?.revision)
  })

  test('compacts selected entries while preserving unselected entries', async () => {
    for (const [minute, id, markdown] of [
      ['18', 'entry-a', 'detail a'],
      ['19', 'entry-b', 'detail b'],
      ['20', 'entry-c', 'keep detail c'],
    ] as const) {
      await appendLifeJournalEntry({
        rootDir,
        now: () => new Date(`2026-07-07T15:${minute}:00.000Z`),
        id: () => id,
        markdown,
      })
    }
    const [before] = await readRecentLifeJournalFiles({ rootDir, days: 1 })

    const result = await compactLifeJournalEntries({
      rootDir,
      now: () => new Date('2026-07-07T16:00:00.000Z'),
      id: () => 'entry-compact',
      date: '2026-07-07',
      entryIds: ['entry-a', 'entry-b'],
      expectedRevision: before!.revision,
      markdown: 'combined detail',
    })

    const [after] = await readRecentLifeJournalFiles({ rootDir, days: 1 })
    assert.deepEqual(after?.entries.map((entry) => entry.id), ['entry-compact', 'entry-c'])
    assert.match(after?.content ?? '', /combined detail/)
    assert.match(after?.content ?? '', /keep detail c/)
    assert.doesNotMatch(after?.content ?? '', /detail a|detail b/)
    assert.deepEqual(result.compactedEntryIds, ['entry-a', 'entry-b'])
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

  test('agenda revision prevents stale overwrite', async () => {
    const before = await readLifeAgendaSnapshot({ rootDir })
    const written = await writeLifeAgendaIfRevision(
      { rootDir, expectedRevision: before.revision },
      '# Agenda\n\n## Active\n- [ ] revised\n',
    )
    assert.notEqual(written.revision, before.revision)
    await assert.rejects(
      writeLifeAgendaIfRevision(
        { rootDir, expectedRevision: before.revision },
        '# Agenda\n\n## Active\n- [ ] stale\n',
      ),
      (error: unknown) => error instanceof LifeJournalStoreError && error.code === 'revision_conflict',
    )
  })

  test('readRecentLifeJournalFiles returns at most latest daily files', async () => {
    await mkdir(join(rootDir, 'life', 'journal'), { recursive: true })
    for (const [date, id, content] of [
      ['2026-07-05T01:00:00.000Z', 'old', 'old'],
      ['2026-07-06T01:00:00.000Z', 'middle', 'middle'],
      ['2026-07-07T01:00:00.000Z', 'latest', 'latest'],
    ] as const) {
      await appendLifeJournalEntry({ rootDir, now: () => new Date(date), id: () => id, markdown: content })
    }
    await writeFile(join(rootDir, 'life', 'journal', 'notes.txt'), 'ignored', 'utf8')

    const files = await readRecentLifeJournalFiles({ rootDir, days: 2 })

    assert.deepEqual(
      files.map((file) => file.path),
      [
        join(rootDir, 'life', 'journal', '2026-07-07.md'),
        join(rootDir, 'life', 'journal', '2026-07-06.md'),
      ],
    )
    assert.match(files[0]!.content, /latest/)
    assert.match(files[1]!.content, /middle/)
    assert.equal(files.every((file) => /^[a-f0-9]{64}$/.test(file.revision)), true)
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
