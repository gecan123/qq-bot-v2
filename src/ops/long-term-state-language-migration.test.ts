import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendLifeJournalEntry, readLifeAgendaSnapshot, readLifeJournalDay, writeLifeAgenda } from '../agent/life-journal-store.js'
import { readMemoryFile, writeMemoryEntry } from '../agent/memory-store.js'
import { appendNotebookRecord, listNotebookRecords } from '../agent/notebook-store.js'
import {
  assertLongTermStateUsesChinese,
  migrateLongTermStateToChinese,
  repairNestedLifeJournalEntries,
} from './long-term-state-language-migration.js'

test('migrates human-readable long-term state to Chinese while preserving machine structure', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'long-term-language-migration-'))
  try {
    const memory = await writeMemoryEntry({ rootDir, id: () => 'memory-1' }, {
      scope: 'self',
      title: 'OpenAI migration notes',
      content: 'Keep API names and paths unchanged while translating the explanation.',
    })
    await appendNotebookRecord({ rootDir, id: () => 'notebook-1' }, {
      kind: 'project',
      topic: 'Language migration',
      content: 'Translate old notebook entries without changing facts.',
    })
    await appendLifeJournalEntry({
      rootDir,
      id: () => 'journal-1',
      now: () => new Date('2026-07-18T02:00:00.000Z'),
      roundIndex: 1,
      markdown: '### Saw\n- A quiet migration test.\n\n### Mood\n- Careful and calm.',
    })
    await writeLifeAgenda({ rootDir }, '# Agenda\n\n## Active\n- [ ] Finish the language migration.\n\n## Waiting\n\n## Someday\n\n## Done\n')

    const result = await migrateLongTermStateToChinese({
      rootDir,
      now: () => new Date('2026-07-18T03:00:00.000Z'),
      async translate(items) {
        return items.map((item) => ({
          key: item.key,
          text: item.key.endsWith(':title') || item.key.includes(':alias:')
            ? 'OpenAI 中文迁移记录'
            : item.key.endsWith(':topic')
              ? '长期状态语言迁移'
              : item.key.startsWith('memory:')
                ? '翻译说明时保留 API 名称和路径原文。'
                : item.key.startsWith('notebook:')
                  ? '在不改变事实的前提下翻译旧 Notebook 条目。'
                  : item.key.startsWith('life:')
                    ? '### 看到\n- 完成了一次谨慎的迁移测试。\n\n### 心情\n- 平静而仔细。'
                    : '完成长期状态语言迁移。',
        }))
      },
    })

    assert.equal(result.translatedItems, 6)
    assert.equal(result.translated.memoryTitles, 1)
    assert.equal(result.translated.memoryEntries, 1)
    assert.equal(result.translated.notebookTopics, 1)
    assert.equal(result.translated.notebookEntries, 1)
    assert.equal(result.translated.lifeJournalEntries, 1)
    assert.equal(result.translated.agendaItems, 1)
    assert.match(result.backupDir, /long-term-language-2026-07-18_03-00-00-000/)
    assert.match(await readFile(join(result.backupDir, 'memory', memory.file), 'utf8'), /OpenAI migration notes/)

    const migratedMemory = await readMemoryFile({ rootDir }, {
      file: 'self/self.md',
      maxChars: 12_000,
    })
    assert.equal(migratedMemory.ok, true)
    if (migratedMemory.ok) {
      assert.match(migratedMemory.entries[0]!.content, /保留 API 名称/)
      assert.deepEqual(migratedMemory.entries[0]!.aliases, ['OpenAI 中文迁移记录'])
    }

    const notebooks = await listNotebookRecords({ rootDir })
    assert.equal(notebooks.entries[0]!.topic, '长期状态语言迁移')
    assert.match(notebooks.entries[0]!.content, /不改变事实/)

    const journal = await readLifeJournalDay({ rootDir, date: '2026-07-18' })
    assert.match(journal.entries[0]!.markdown, /### 看到/)
    assert.doesNotMatch(journal.entries[0]!.markdown, /### Saw/)
    const agenda = await readLifeAgendaSnapshot({ rootDir })
    assert.match(agenda.markdown, /## Active/)
    assert.match(agenda.markdown, /完成长期状态语言迁移/)
    await assertLongTermStateUsesChinese(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('repairs a phantom outer Life Journal entry without losing the meaningful nested entry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'nested-life-journal-repair-'))
  try {
    const journalDir = join(rootDir, 'life', 'journal')
    await mkdir(journalDir, { recursive: true })
    await writeFile(join(journalDir, '2026-07-18.md'), `# Life Journal 2026-07-18

<!-- life-journal-format: 2 -->

<!-- life-journal-entry
id: phantom
date: 2026-07-18
kind: reflection
source: round
createdAt: 2026-07-18T03:07:00.000+08:00
roundIndex: 17
-->
## 03:07 Round 17

<!-- life-journal-entry
id: meaningful
date: 2026-07-18
kind: reflection
source: round
createdAt: 2026-07-18T03:04:00.000+08:00
roundIndex: 16
-->
## 03:04 Round 16

### 看到
- 保留这条有内容的记录。
<!-- /life-journal-entry -->
`, 'utf8')

    assert.equal(await repairNestedLifeJournalEntries(rootDir), 1)
    const file = await readLifeJournalDay({ rootDir, date: '2026-07-18' })
    assert.deepEqual(file.entries.map((entry) => entry.id), ['meaningful'])
    assert.match(file.entries[0]!.markdown, /保留这条有内容的记录/)
    assert.doesNotMatch(file.content, /id: phantom/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('normalizes an invalid round marker and removes its duplicate close marker', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'invalid-life-journal-round-repair-'))
  try {
    const journalDir = join(rootDir, 'life', 'journal')
    await mkdir(journalDir, { recursive: true })
    await writeFile(join(journalDir, '2026-07-17.md'), `# Life Journal 2026-07-17

<!-- life-journal-format: 2 -->

<!-- life-journal-entry
id: invalid-round
date: 2026-07-17
kind: reflection
source: round
createdAt: 2026-07-17T12:10:00.000+08:00
roundIndex: midday
-->
## 12:10 Midday

### 看到
- 保留这条记录。
<!-- /life-journal-entry -->
<!-- /life-journal-entry -->
`, 'utf8')

    assert.equal(await repairNestedLifeJournalEntries(rootDir), 2)
    const file = await readLifeJournalDay({ rootDir, date: '2026-07-17' })
    assert.equal(file.entries.length, 1)
    assert.equal(file.entries[0]!.source, 'manual')
    assert.equal(file.entries[0]!.roundIndex, undefined)
    assert.match(file.content, /## 12:10 Manual/)
    assert.equal(file.content.match(/<!-- \/life-journal-entry -->/g)?.length, 1)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
