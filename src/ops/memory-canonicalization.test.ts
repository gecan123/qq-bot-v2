import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { inspectMemoryFileForMaintenance, recallMemoryEntries, writeMemoryEntry } from '../agent/memory-store.js'
import { canonicalizeSelfTopicMemory } from './memory-canonicalization.js'

describe('self/topic memory canonicalization', () => {
  test('previews and atomically consolidates old self/topic files while preserving entries and title recall', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'memory-canonicalization-'))
    try {
      await writeLegacyMemory(rootDir, 'self/first.md', 'self', '第一份自我记录', 'self-1', '先看真实日志')
      await writeLegacyMemory(rootDir, 'self/second.md', 'self', '第二份自我记录', 'self-2', '不要重复轮询')
      await writeLegacyMemory(rootDir, 'topics/night.md', 'topic', 'lit-window 夜间模式', 'topic-1', '夜间低频活跃')
      await writeLegacyMemory(rootDir, 'topics/dawn.md', 'topic', 'lit-window 跨日模式', 'topic-2', '活跃延伸到清晨')
      await writeMemoryEntry({ rootDir, id: () => 'person-1' }, {
        scope: 'person', id: '10001', context: { kind: 'core' }, content: '喜欢短句',
      })

      const preview = await canonicalizeSelfTopicMemory({ rootDir })
      assert.equal(preview.applied, false)
      assert.equal(preview.filesBefore, 5)
      assert.equal(preview.filesAfter, 3)
      assert.equal(preview.consolidatedFiles, 4)
      assert.equal(preview.entries, 5)
      assert.match(await readFile(join(rootDir, 'memory', 'self', 'first.md'), 'utf8'), /第一份自我记录/)

      const applied = await canonicalizeSelfTopicMemory({
        rootDir,
        apply: true,
        now: () => new Date('2026-07-20T00:00:00.000Z'),
      })
      assert.equal(applied.applied, true)
      assert.ok(applied.backupDir)
      assert.match(await readFile(join(applied.backupDir!, 'memory', 'self', 'first.md'), 'utf8'), /第一份自我记录/)

      const self = await inspectMemoryFileForMaintenance({ rootDir }, 'self/self.md')
      const topics = await inspectMemoryFileForMaintenance({ rootDir }, 'topics/topics.md')
      assert.deepEqual(self.entries.map((entry) => entry.id), ['self-1', 'self-2'])
      assert.deepEqual(topics.entries.map((entry) => entry.id), ['topic-1', 'topic-2'])
      assert.deepEqual(topics.entries.map((entry) => entry.aliases), [
        ['lit-window 夜间模式'],
        ['lit-window 跨日模式'],
      ])
      const recalled = await recallMemoryEntries({ rootDir }, { scope: 'topic', query: 'lit-window 跨日模式' })
      assert.deepEqual(recalled.matches.map((match) => match.entryId), ['topic-2'])
      assert.match(await readFile(join(rootDir, 'memory', 'people', '10001', 'core.md'), 'utf8'), /喜欢短句/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

async function writeLegacyMemory(
  rootDir: string,
  file: string,
  scope: 'self' | 'topic',
  title: string,
  entryId: string,
  content: string,
): Promise<void> {
  const path = join(rootDir, 'memory', file)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, [
    '---',
    'formatVersion: 2',
    `scope: ${scope}`,
    `title: ${title}`,
    'updatedAt: 2026-07-19T08:00:00.000+08:00',
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
    '## 最近线索',
    '',
    '<!-- memory-entry',
    `id: ${entryId}`,
    'createdAt: 2026-07-19T08:00:00.000+08:00',
    'updatedAt: 2026-07-19T08:00:00.000+08:00',
    'tier: recent',
    'status: active',
    'aliases: []',
    'supersedes: []',
    '-->',
    `- ${content}`,
    '<!-- /memory-entry -->',
    '',
  ].join('\n'), 'utf8')
}
