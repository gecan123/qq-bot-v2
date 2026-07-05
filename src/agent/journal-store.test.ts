import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  appendJournalRecord,
  listJournalRecords,
  readJournalRecord,
  searchJournalRecords,
  type JournalStoreOptions,
} from './journal-store.js'

describe('workspace journal store', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'qq-bot-journal-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  function storeOptions(id = 'entry-1', date = '2026-06-23T01:02:03.000Z'): JournalStoreOptions {
    return {
      rootDir,
      id: () => id,
      now: () => new Date(date),
    }
  }

  test('appendJournalRecord creates a monthly Markdown journal file', async () => {
    const entry = await appendJournalRecord(storeOptions(), {
      kind: 'diary',
      content: '今天整理了一点自己的想法',
    })

    const raw = await readFile(join(rootDir, 'journal', 'diary', '2026-06.md'), 'utf8')
    assert.match(raw, /^# Diary 2026-06/)
    assert.match(raw, /<!-- journal-entry/)
    assert.match(raw, /id: entry-1/)
    assert.match(raw, /createdAt: 2026-06-23T01:02:03.000Z/)
    assert.match(raw, /今天整理了一点自己的想法/)
    assert.deepEqual(entry, {
      id: 'entry-1',
      kind: 'diary',
      content: '今天整理了一点自己的想法',
      createdAt: '2026-06-23T01:02:03.000Z',
    })
  })

  test('appended row includes stable fields', async () => {
    const entry = await appendJournalRecord(storeOptions('stable-id'), {
      kind: 'dream',
      content: '梦见在海底走路',
    })

    assert.deepEqual(entry, {
      id: 'stable-id',
      kind: 'dream',
      content: '梦见在海底走路',
      createdAt: '2026-06-23T01:02:03.000Z',
    })
  })

  test('listJournalRecords returns newest entries first and can filter by kind', async () => {
    await appendJournalRecord(storeOptions('old', '2026-06-22T01:00:00.000Z'), {
      kind: 'dream',
      content: '旧梦',
    })
    await appendJournalRecord(storeOptions('new-diary', '2026-06-23T01:00:00.000Z'), {
      kind: 'diary',
      content: '新日记',
    })
    await appendJournalRecord(storeOptions('new-dream', '2026-06-24T01:00:00.000Z'), {
      kind: 'dream',
      content: '新梦',
    })

    const all = await listJournalRecords({ rootDir })
    assert.deepEqual(all.entries.map((entry) => entry.id), ['new-dream', 'new-diary', 'old'])

    const dreams = await listJournalRecords({ rootDir }, { kind: 'dream' })
    assert.deepEqual(dreams.entries.map((entry) => entry.id), ['new-dream', 'old'])
  })

  test('searchJournalRecords matches content case-insensitively', async () => {
    await appendJournalRecord(storeOptions('a', '2026-06-22T01:00:00.000Z'), {
      kind: 'diary',
      content: 'Alpha beta',
    })
    await appendJournalRecord(storeOptions('b', '2026-06-23T01:00:00.000Z'), {
      kind: 'dream',
      content: 'gamma',
    })

    const result = await searchJournalRecords({ rootDir }, { query: 'ALPHA' })
    assert.deepEqual(result.entries.map((entry) => entry.id), ['a'])
  })

  test('readJournalRecord reads a Markdown section by id', async () => {
    await appendJournalRecord(storeOptions('a', '2026-06-22T01:00:00.000Z'), {
      kind: 'diary',
      content: 'Alpha beta',
    })

    const result = await readJournalRecord({ rootDir }, 'a')
    assert.deepEqual(result.entry, {
      id: 'a',
      kind: 'diary',
      content: 'Alpha beta',
      createdAt: '2026-06-22T01:00:00.000Z',
    })
  })

  test('corrupt Markdown journal sections are skipped and reported through skippedCorrupt', async () => {
    await mkdir(join(rootDir, 'journal', 'diary'), { recursive: true })
    await writeFile(
      join(rootDir, 'journal', 'diary', '2026-06.md'),
      [
        '# Diary 2026-06',
        '',
        '<!-- journal-entry',
        'id: valid',
        'kind: diary',
        'createdAt: 2026-06-23T01:00:00.000Z',
        '-->',
        '能读到的内容',
        '<!-- /journal-entry -->',
        '',
        '<!-- journal-entry',
        'id: missing-close',
        'kind: diary',
        'createdAt: 2026-06-24T01:00:00.000Z',
        '',
      ].join('\n'),
      'utf8',
    )

    const result = await listJournalRecords({ rootDir })
    assert.deepEqual(result.entries.map((entry) => entry.id), ['valid'])
    assert.equal(result.skippedCorrupt, 1)
  })
})
