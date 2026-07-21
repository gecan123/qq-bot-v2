import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { recallMemoryEntries } from '../agent/memory-store.js'
import { migrateMemoryToV2 } from './memory-v2-migration.js'

const CREATED_AT = '2026-07-18T13:15:59.450+08:00'

describe('memory v2 migration', () => {
  test('separates group-level memory, contextual person observations, and quarantined legacy person facts', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'memory-v2-migration-'))
    try {
      await writeOldMemory(rootDir, 'groups/20001.md', 'group', '测试群', [
        oldEntry('group-topic', '群里经常讨论 TypeScript 和数据库设计。', [10]),
        oldEntry('person-job', '群友「小王」（QQ 10001）= 公务员，不是程序员。', []),
      ])
      await writeOldMemory(rootDir, 'people/99999.md', 'person', '旧人物', [
        oldEntry('legacy-person', '旧人物喜欢咖啡，但不知道这来自哪个聊天场景。', []),
      ])

      const dryRun = await migrateMemoryToV2({ rootDir })
      assert.equal(dryRun.applied, false)
      assert.equal(dryRun.needed, true)
      assert.equal(dryRun.movedPersonEntries, 1)
      assert.equal(dryRun.quarantinedPersonEntries, 1)
      assert.match(await readFile(join(rootDir, 'memory', 'groups', '20001.md'), 'utf8'), /formatVersion: 1/)

      const applied = await migrateMemoryToV2({
        rootDir,
        apply: true,
        now: () => new Date('2026-07-19T12:00:00.000Z'),
        async loadSourceEvidence(ids) {
          return ids.map((rowId) => ({
            rowId,
            sceneKind: 'qq_group' as const,
            sceneExternalId: '',
            groupId: 20001,
            messageId: String(rowId * 10),
            senderId: '10002',
            sentAt: CREATED_AT,
          }))
        },
      })
      assert.equal(applied.applied, true)
      assert.equal(applied.filesBefore, 2)
      assert.equal(applied.filesAfter, 3)
      assert.ok(applied.backupDir)
      assert.deepEqual(applied.changes.map((change) => change.to).sort(), [
        'groups/20001.md',
        'people/10001/groups/20001.md',
        'people/99999/unscoped.md',
      ])
      assert.match(await readFile(join(applied.backupDir!, 'memory', 'groups', '20001.md'), 'utf8'), /formatVersion: 1/)

      const group = await readFile(join(rootDir, 'memory', 'groups', '20001.md'), 'utf8')
      assert.match(group, /formatVersion: 2/)
      assert.match(group, /group_topic/)
      assert.doesNotMatch(group, /小王/)

      const contextual = await readFile(join(rootDir, 'memory', 'people', '10001', 'groups', '20001.md'), 'utf8')
      assert.match(contextual, /contextKind: qq_group/)
      assert.match(contextual, /contextId: 20001/)
      assert.match(contextual, /memoryKind: person_identity/)
      assert.match(contextual, /evidenceKind: legacy_unverified/)
      assert.match(contextual, /status: disputed/)

      const quarantined = await readFile(join(rootDir, 'memory', 'people', '99999', 'unscoped.md'), 'utf8')
      assert.match(quarantined, /contextKind: legacy_unscoped/)
      assert.match(quarantined, /status: disputed/)

      const currentContext = await recallMemoryEntries({ rootDir }, {
        query: '公务员',
        scope: 'person',
        id: '10001',
        context: { kind: 'qq_group', id: '20001' },
      })
      assert.deepEqual(currentContext.matches.map((match) => match.entryId), ['person-job'])
      const quarantinedRecall = await recallMemoryEntries({ rootDir }, {
        query: '咖啡',
        scope: 'person',
        id: '99999',
        context: { kind: 'qq_group', id: '20001' },
      })
      assert.deepEqual(quarantinedRecall.matches, [])

      const completedPreview = await migrateMemoryToV2({ rootDir })
      assert.equal(completedPreview.applied, false)
      assert.equal(completedPreview.needed, false)

      const groupPath = join(rootDir, 'memory', 'groups', '20001.md')
      await writeFile(groupPath, `${await readFile(groupPath, 'utf8')}\n<!-- ignored operator note -->\n`, 'utf8')
      const rawDriftPreview = await migrateMemoryToV2({ rootDir })
      assert.equal(rawDriftPreview.needed, true)
      assert.notEqual(rawDriftPreview.stateFingerprint, completedPreview.stateFingerprint)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('marks a partially migrated V2 document as needed when planned metadata changes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'memory-v2-partial-'))
    try {
      await writeOldMemory(rootDir, 'groups/20001.md', 'group', '测试群', [
        oldEntry('group-topic', '群里经常讨论 TypeScript。', []),
      ])
      const path = join(rootDir, 'memory', 'groups', '20001.md')
      await writeFile(path, (await readFile(path, 'utf8')).replace('formatVersion: 1', 'formatVersion: 2'), 'utf8')

      const preview = await migrateMemoryToV2({ rootDir })

      assert.equal(preview.needed, true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function oldEntry(id: string, content: string, sourceMessageIds: number[]): string {
  return [
    '<!-- memory-entry',
    `id: ${id}`,
    `createdAt: ${CREATED_AT}`,
    `updatedAt: ${CREATED_AT}`,
    'tier: recent',
    'status: active',
    'aliases: []',
    'supersedes: []',
    ...(sourceMessageIds.length > 0 ? [`sourceMessageIds: ${sourceMessageIds.join(',')}`] : []),
    '-->',
    `- ${content}`,
    '<!-- /memory-entry -->',
  ].join('\n')
}

async function writeOldMemory(
  rootDir: string,
  file: string,
  scope: 'person' | 'group',
  title: string,
  entries: string[],
): Promise<void> {
  const path = join(rootDir, 'memory', file)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, [
    '---',
    'formatVersion: 1',
    `scope: ${scope}`,
    `title: ${title}`,
    `updatedAt: ${CREATED_AT}`,
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
    '## 最近线索',
    '',
    ...entries,
    '',
  ].join('\n'), 'utf8')
}
