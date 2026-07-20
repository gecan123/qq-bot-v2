import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { appendLifeJournalEntry, writeLifeAgenda } from '../agent/life-journal-store.js'
import {
  applyMemoryMaintenance,
  compactMemoryEntries,
  inspectMemoryFileForMaintenance,
  readMemoryFile,
  writeMemoryEntry,
} from '../agent/memory-store.js'
import { appendNotebookRecord } from '../agent/notebook-store.js'
import {
  checkAgentMemory,
  memoryCheckExitCode,
} from './agent-memory-check.js'

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  async function walk(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else output[relative(root, path)] = await readFile(path, 'utf8')
    }
  }
  await walk(root)
  return output
}

describe('agent memory check', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agent-memory-check-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('reports counts, lifecycle states, duplicate IDs, broken supersedes, and corrupt files', async () => {
    let memoryId = 0
    const now = () => new Date('2026-07-13T08:00:00.000Z')
    await writeMemoryEntry({ rootDir, now, id: () => ['duplicate-id', 'superseded-id', 'active-id'][memoryId++]! }, {
      scope: 'self', title: 'facts', content: '第一条事实',
    })
    await writeMemoryEntry({ rootDir, now, id: () => ['duplicate-id', 'superseded-id', 'active-id'][memoryId++]! }, {
      scope: 'self', title: 'facts', content: '第二条事实',
    })
    await writeMemoryEntry({ rootDir, now, id: () => ['duplicate-id', 'superseded-id', 'active-id'][memoryId++]! }, {
      scope: 'self', title: 'facts', content: '第三条事实',
    })
    const factsPath = join(rootDir, 'memory', 'self', 'self.md')
    let facts = await readFile(factsPath, 'utf8')
    facts = facts
      .replace('tier: recent', 'tier: stable')
      .replace('status: active', 'status: disputed')
      .replace('supersedes: []', 'validUntil: 2026-07-01T00:00:00.000+08:00\nsupersedes: ["missing-id"]')
      .replace('status: active', 'status: superseded')
    await writeFile(factsPath, facts, 'utf8')

    await writeMemoryEntry({ rootDir, now, id: () => 'self-ref-id' }, {
      scope: 'topic', title: 'self-reference', content: '自引用条目',
    })
    const selfRefPath = join(rootDir, 'memory', 'topics', 'topics.md')
    await writeFile(
      selfRefPath,
      (await readFile(selfRefPath, 'utf8')).replace('supersedes: []', 'supersedes: ["self-ref-id"]'),
      'utf8',
    )
    await mkdir(join(rootDir, 'memory', 'groups'), { recursive: true })
    await writeFile(join(rootDir, 'memory', 'groups', 'corrupt.md'), 'not memory v1\n', 'utf8')

    await appendNotebookRecord({ rootDir, now, id: () => 'duplicate-id' }, {
      kind: 'research', topic: 'memory', content: '研究过程',
    })
    await mkdir(join(rootDir, 'notebook', 'research'), { recursive: true })
    await writeFile(join(rootDir, 'notebook', 'research', '2026-08.md'), '<!-- notebook-entry\ninvalid\n', 'utf8')

    await appendLifeJournalEntry({ rootDir, now, id: () => 'life-id', markdown: '### Saw\n- 发生了一件事。' })
    await writeFile(join(rootDir, 'life', 'journal', '2026-07-12.md'), '# unsupported journal\n', 'utf8')
    await writeLifeAgenda({ rootDir }, '# Agenda\n\n## Active\n- [ ] 检查记忆\n')

    const before = await snapshotFiles(rootDir)
    const report = await checkAgentMemory({ rootDir, now: new Date('2026-07-13T08:00:00.000Z') })
    const after = await snapshotFiles(rootDir)

    assert.deepEqual(after, before)
    assert.deepEqual(report.counts, {
      memory: { files: 3, entries: 3 },
      notebook: { files: 2, entries: 1 },
      lifeJournal: { files: 2, entries: 1 },
    })
    assert.equal(report.lifecycle.expired, 1)
    assert.equal(report.lifecycle.disputed, 1)
    assert.equal(report.lifecycle.superseded, 1)
    assert.equal(report.lifecycle.stableWithoutSources, 1)
    assert.equal(report.issues.corruptOrUnsupportedFiles.length, 4)
    assert.equal(report.issues.duplicateIds.some((item) => item.id === 'duplicate-id'), true)
    assert.equal(report.issues.selfReferencingSupersedes.some((item) => item.id === 'self-ref-id'), true)
    assert.equal(report.issues.unknownSupersedes.some((item) => item.targetId === 'missing-id'), true)
    assert.equal(report.agenda.exists, true)
    assert.equal(report.agenda.sizeBytes, Buffer.byteLength(before['life/agenda.md']!, 'utf8'))
    assert.match(report.agenda.revision ?? '', /^[a-f0-9]{64}$/)
    assert.equal(report.ok, false)
    assert.equal(memoryCheckExitCode(report), 1)
  })

  test('does not create missing state while checking an empty root', async () => {
    const before = await snapshotFiles(rootDir)
    const report = await checkAgentMemory({ rootDir })

    assert.deepEqual(await snapshotFiles(rootDir), before)
    assert.equal(report.ok, true)
    assert.deepEqual(report.issues.corruptOrUnsupportedFiles, [])
    assert.deepEqual(report.agenda, { exists: false, revision: null, sizeBytes: 0 })
    assert.equal(memoryCheckExitCode(report), 0)
  })

  test('keeps compact and maintenance supersedes references resolvable', async () => {
    let nextId = 0
    const options = {
      rootDir,
      now: () => new Date('2026-07-13T08:00:00.000Z'),
      id: () => `entry-${++nextId}`,
    }
    await writeMemoryEntry(options, { scope: 'self', title: 'compact', content: '线索一' })
    const second = await writeMemoryEntry(options, { scope: 'self', title: 'compact', content: '线索二' })
    await compactMemoryEntries(options, {
      file: 'self/self.md',
      entryIds: ['entry-1', 'entry-2'],
      expectedRevision: second.revision,
      content: '合并后的稳定结论',
    })

    await writeMemoryEntry(options, { scope: 'self', title: 'maintenance', content: '维护线索一' })
    await writeMemoryEntry(options, { scope: 'self', title: 'maintenance', content: '维护线索二' })
    const maintenance = await inspectMemoryFileForMaintenance({ rootDir }, 'self/self.md')
    await applyMemoryMaintenance(options, {
      file: 'self/self.md',
      expectedRevision: maintenance.revision,
      operations: [{
        action: 'merge',
        entryIds: ['entry-4', 'entry-5'],
        content: '维护后的稳定结论',
      }],
    })

    const report = await checkAgentMemory({ rootDir })
    const compacted = await readMemoryFile({ rootDir }, { file: 'self/self.md' })
    const maintained = compacted

    assert.equal(report.ok, true)
    assert.deepEqual(report.issues.unknownSupersedes, [])
    assert.equal(report.lifecycle.superseded, 4)
    assert.equal(compacted.ok && compacted.entries.filter((entry) => entry.status === 'superseded').length, 4)
    assert.equal(maintained.ok && maintained.entries.filter((entry) => entry.status === 'superseded').length, 4)
  })
})
