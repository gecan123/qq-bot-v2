import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMemoryMaintenance,
  compactMemoryEntries,
  deleteMemoryEntry,
  deleteMemoryFiles,
  inspectMemoryFileForMaintenance,
  listMemoryFiles,
  markMemoryEntryDisputed,
  MemoryStoreError,
  readMemoryFile,
  recallMemoryEntries,
  proposeMemoryReview,
  searchMemoryEntries,
  supersedeMemoryEntry,
  updateMemoryEntry,
  writeMemoryEntry,
} from './memory-store.js'
import { createWorkspaceStateCoordinator, type WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

function createGatedCoordinator(): {
  coordinator: WorkspaceStateCoordinator
  entered: Promise<void>
  release: () => void
  resourceKeys: string[]
} {
  const base = createWorkspaceStateCoordinator()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const resourceKeys: string[] = []
  let gateFirst = true
  return {
    entered,
    release,
    resourceKeys,
    coordinator: {
      withWrite(resourceKey, task) {
        resourceKeys.push(resourceKey)
        return base.withWrite(resourceKey, async () => {
          if (gateFirst) {
            gateFirst = false
            enter()
            await gate
          }
          return task()
        })
      },
    },
  }
}

async function withTempMemory<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-store-'))
  try {
    return await fn(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

describe('memory-store', () => {
  test('writes self memory to a markdown file with frontmatter', async () => {
    await withTempMemory(async (rootDir) => {
      const result = await writeMemoryEntry({
        rootDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      }, {
        scope: 'self',
        title: 'working-notes',
        content: '以后做本地记忆优先保持 tool result 有上限',
      })

      assert.equal(result.ok, true)
      assert.equal(result.file, 'self/working-notes.md')

      const raw = await readFile(join(rootDir, 'memory', 'self', 'working-notes.md'), 'utf8')
      assert.match(raw, /scope: self/)
      assert.match(raw, /title: working-notes/)
      assert.match(raw, /updatedAt: 2026-06-27T08:00:00.000\+08:00/)
      assert.match(raw, /<!-- memory-entry/)
      assert.match(raw, /- 以后做本地记忆优先保持 tool result 有上限/)
      assert.match(result.entryId, /^mem_/)
      assert.match(result.revision, /^[a-f0-9]{64}$/)
    })
  })

  test('round-trips expanded entry fields and defaults legacy entry fields', async () => {
    await withTempMemory(async (rootDir) => {
      const directory = join(rootDir, 'memory', 'self')
      const file = join(directory, 'expanded.md')
      await mkdir(directory, { recursive: true })
      await writeFile(file, [
        '---',
        'formatVersion: 1',
        'scope: self',
        'title: expanded',
        'updatedAt: 2026-07-01T08:00:00.000+08:00',
        'aliases: []',
        '---',
        '',
        '## 稳定记忆',
        '',
        '<!-- memory-entry',
        'id: entry-new',
        'createdAt: 2026-07-01T08:00:00.000+08:00',
        'updatedAt: 2026-07-02T08:00:00.000+08:00',
        'tier: stable',
        'status: disputed',
        'aliases: ["常用别名","alias,with,comma"]',
        'validUntil: 2026-12-31T23:59:59.000+08:00',
        'supersedes: ["entry-old"]',
        'sourceMessageIds: 11,12',
        '-->',
        '- 完整字段不会在 Markdown round-trip 中丢失',
        '<!-- /memory-entry -->',
        '',
        '## 最近线索',
        '',
        '<!-- memory-entry',
        'id: entry-old',
        'createdAt: 2026-06-01T08:00:00.000+08:00',
        'tier: recent',
        '-->',
        '- 旧格式条目仍然可读',
        '<!-- /memory-entry -->',
        '',
      ].join('\n'), 'utf8')

      const before = await readMemoryFile({ rootDir }, { file: 'self/expanded.md' })
      assert.equal(before.ok, true)
      if (!before.ok) return
      assert.deepEqual(before.entries, [
        {
          id: 'entry-new',
          createdAt: '2026-07-01T08:00:00.000+08:00',
          updatedAt: '2026-07-02T08:00:00.000+08:00',
          content: '完整字段不会在 Markdown round-trip 中丢失',
          sourceMessageIds: [11, 12],
          tier: 'stable',
          status: 'disputed',
          aliases: ['常用别名', 'alias,with,comma'],
          validUntil: '2026-12-31T23:59:59.000+08:00',
          supersedes: ['entry-old'],
        },
        {
          id: 'entry-old',
          createdAt: '2026-06-01T08:00:00.000+08:00',
          updatedAt: '2026-06-01T08:00:00.000+08:00',
          content: '旧格式条目仍然可读',
          sourceMessageIds: [],
          tier: 'recent',
          status: 'active',
          aliases: [],
          supersedes: [],
        },
      ])

      await updateMemoryEntry({
        rootDir,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
      }, {
        file: 'self/expanded.md',
        entryId: 'entry-new',
        expectedRevision: before.revision,
        content: '更新后仍保留全部扩展字段',
      })
      const after = await readMemoryFile({ rootDir }, { file: 'self/expanded.md' })
      assert.equal(after.ok, true)
      if (!after.ok) return
      assert.deepEqual(after.entries[0], {
        ...before.entries[0],
        updatedAt: '2026-07-03T08:00:00.000+08:00',
        content: '更新后仍保留全部扩展字段',
      })
      assert.match(after.content, /aliases: \["常用别名","alias,with,comma"\]/)
      assert.match(after.content, /supersedes: \["entry-old"\]/)
    })
  })

  test('treats invalid validUntil and self-superseding entries as invalid files', async () => {
    await withTempMemory(async (rootDir) => {
      const directory = join(rootDir, 'memory', 'self')
      await mkdir(directory, { recursive: true })
      const raw = (extra: string) => [
        '---',
        'formatVersion: 1',
        'scope: self',
        'title: invalid',
        'updatedAt: 2026-07-01T08:00:00.000+08:00',
        'aliases: []',
        '---',
        '',
        '## 稳定记忆',
        '',
        '## 最近线索',
        '',
        '<!-- memory-entry',
        'id: entry-1',
        'createdAt: 2026-07-01T08:00:00.000+08:00',
        'tier: recent',
        extra,
        '-->',
        '- invalid entry',
        '<!-- /memory-entry -->',
        '',
      ].join('\n')
      await writeFile(join(directory, 'invalid-time.md'), raw('validUntil: someday'), 'utf8')
      await writeFile(join(directory, 'self-reference.md'), raw('supersedes: ["entry-1"]'), 'utf8')

      assert.deepEqual(
        await readMemoryFile({ rootDir }, { file: 'self/invalid-time.md' }),
        { ok: false, error: 'memory file format is not supported' },
      )
      assert.deepEqual(
        await readMemoryFile({ rootDir }, { file: 'self/self-reference.md' }),
        { ok: false, error: 'memory file format is not supported' },
      )
      assert.equal((await listMemoryFiles({ rootDir })).skippedCorrupt, 2)
    })
  })

  test('marks disputed entries and records explicit supersession links', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `status-${++nextId}`,
      }
      await writeMemoryEntry(options, { scope: 'self', title: 'facts', content: '旧事实' })
      await writeMemoryEntry(options, { scope: 'self', title: 'facts', content: '新事实' })
      let snapshot = await readMemoryFile({ rootDir }, { file: 'self/facts.md' })
      assert.equal(snapshot.ok, true)
      if (!snapshot.ok) return

      await markMemoryEntryDisputed(options, {
        file: 'self/facts.md',
        entryId: 'status-1',
        expectedRevision: snapshot.revision,
      })
      snapshot = await readMemoryFile({ rootDir }, { file: 'self/facts.md' })
      assert.equal(snapshot.ok, true)
      if (!snapshot.ok) return
      assert.equal(snapshot.entries[0]?.status, 'disputed')

      await supersedeMemoryEntry(options, {
        file: 'self/facts.md',
        entryId: 'status-1',
        replacementEntryId: 'status-2',
        expectedRevision: snapshot.revision,
      })
      snapshot = await readMemoryFile({ rootDir }, { file: 'self/facts.md' })
      assert.equal(snapshot.ok, true)
      if (!snapshot.ok) return
      assert.equal(snapshot.entries.find((entry) => entry.id === 'status-1')?.status, 'superseded')
      assert.deepEqual(snapshot.entries.find((entry) => entry.id === 'status-2')?.supersedes, ['status-1'])

      await assert.rejects(
        supersedeMemoryEntry(options, {
          file: 'self/facts.md',
          entryId: 'status-2',
          replacementEntryId: 'status-2',
          expectedRevision: snapshot.revision,
        }),
        (error: unknown) => error instanceof MemoryStoreError && error.code === 'invalid_selection',
      )
    })
  })

  test('writes person, group, and topic memories to scoped files', async () => {
    await withTempMemory(async (rootDir) => {
      const now = () => new Date('2026-06-27T00:00:00.000Z')
      const person = await writeMemoryEntry({ rootDir, now }, {
        scope: 'person',
        id: '12345',
        content: '喜欢短句',
      })
      const group = await writeMemoryEntry({ rootDir, now }, {
        scope: 'group',
        id: '98765',
        content: '这个群聊 AI 工具很多',
      })
      const topic = await writeMemoryEntry({ rootDir, now }, {
        scope: 'topic',
        title: 'qq-bot-v2',
        content: 'memory 改成本地 Markdown',
      })

      assert.equal(person.file, 'people/12345.md')
      assert.equal(group.file, 'groups/98765.md')
      assert.equal(topic.file, 'topics/qq-bot-v2.md')
    })
  })

  test('requires a stable title for topic memory instead of creating topics/topic.md', async () => {
    await withTempMemory(async (rootDir) => {
      await assert.rejects(
        writeMemoryEntry({ rootDir }, {
          scope: 'topic',
          content: '一条没有稳定主题的速记',
        }),
        /topic memory requires a stable title/,
      )
      await assert.rejects(access(join(rootDir, 'memory', 'topics', 'topic.md')))
    })
  })

  test('deduplicates identical writes inside the same canonical file', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = { rootDir, id: () => `dedupe-${++nextId}` }
      const first = await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人喜欢短句', sourceMessageIds: [1],
      })
      const second = await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人喜欢短句', sourceMessageIds: [2],
      })
      const read = await readMemoryFile({ rootDir }, { file: 'people/123.md' })

      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(second.deduplicated, true)
      assert.equal(second.entryId, first.entryId)
      assert.equal(read.ok && read.entries.length, 1)
    })
  })

  test('serializes append and revision mutation for the same memory file', async () => {
    await withTempMemory(async (rootDir) => {
      const initial = await writeMemoryEntry({ rootDir, id: () => 'initial' }, {
        scope: 'self', title: 'atomic', content: 'initial fact',
      })
      const gated = createGatedCoordinator()
      const append = writeMemoryEntry({
        rootDir,
        id: () => 'appended',
        workspaceStateCoordinator: gated.coordinator,
      }, {
        scope: 'self', title: 'atomic', content: 'appended fact',
      })
      await gated.entered
      const update = updateMemoryEntry({
        rootDir,
        workspaceStateCoordinator: gated.coordinator,
      }, {
        file: 'self/atomic.md',
        entryId: initial.entryId,
        expectedRevision: initial.revision,
        content: 'stale update',
      }).then(() => null, (error: unknown) => error)

      const requestedKeys = [...gated.resourceKeys]
      gated.release()
      await append
      const updateError = await update

      assert.deepEqual(requestedKeys, ['memory:self/atomic.md', 'memory:self/atomic.md'])
      assert.equal(updateError instanceof MemoryStoreError && updateError.code === 'revision_conflict', true)
    })
  })

  test('search returns bounded snippets across scopes', async () => {
    await withTempMemory(async (rootDir) => {
      const now = () => new Date('2026-06-27T00:00:00.000Z')
      await writeMemoryEntry({ rootDir, now }, {
        scope: 'self',
        title: 'working-notes',
        content: 'Markdown memory keeps replay deterministic',
      })
      await writeMemoryEntry({ rootDir, now }, {
        scope: 'topic',
        title: 'browser-sidecar',
        content: 'browser screenshots should stay bounded',
      })

      const result = await searchMemoryEntries({ rootDir }, {
        keyword: 'memory',
        limit: 5,
      })

      assert.equal(result.ok, true)
      assert.equal(result.matches.length, 1)
      assert.equal(result.matches[0]!.file, 'self/working-notes.md')
      assert.equal(result.matches[0]!.scope, 'self')
      assert.match(result.matches[0]!.snippet, /Markdown memory/)
      assert.equal(result.skippedCorrupt, 0)
    })
  })

  test('recall ranks entry-level matches with explainable lexical terms and provenance', async () => {
    await withTempMemory(async (rootDir) => {
      let index = 0
      const options = {
        rootDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
        id: () => `entry-${++index}`,
      }
      await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人喜欢手冲咖啡', sourceMessageIds: [10],
      })
      await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人最近在研究 TypeScript', sourceMessageIds: [11],
      })
      await writeMemoryEntry(options, {
        scope: 'topic', title: '咖啡器具', content: '咖啡滤杯需要预热', sourceMessageIds: [12],
      })

      const result = await recallMemoryEntries({ rootDir }, {
        query: '主人喜欢什么咖啡',
        scope: 'person',
        limit: 5,
      })

      assert.equal(result.matches[0]?.entryId, 'entry-1')
      assert.deepEqual(result.matches[0]?.sourceMessageIds, [10])
      assert.equal(result.matches[0]!.score > 0, true)
      assert.equal(result.matches[0]!.matchedTerms.includes('主人'), true)
      assert.equal(result.matches.some((match) => match.entryId === 'entry-3'), false)
    })
  })

  test('review proposes near duplicates and possible conflicts without mutating markdown', async () => {
    await withTempMemory(async (rootDir) => {
      let index = 0
      const options = {
        rootDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
        id: () => `review-${++index}`,
      }
      await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人喜欢喝手冲咖啡并且每天自己磨豆再慢慢冲煮', sourceMessageIds: [20],
      })
      await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人喜欢喝手冲咖啡而且每天自己磨豆再慢慢冲煮', sourceMessageIds: [21],
      })
      await writeMemoryEntry(options, {
        scope: 'person', id: '123', content: '主人不喜欢喝手冲咖啡而且每天自己磨豆再慢慢冲煮', sourceMessageIds: [22],
      })
      const file = join(rootDir, 'memory', 'people', '123.md')
      const before = await readFile(file, 'utf8')

      const result = await proposeMemoryReview({ rootDir }, {
        file: 'people/123.md',
        limit: 10,
      })

      assert.equal(result.proposals.some((proposal) => proposal.relation === 'near_duplicate'), true)
      assert.equal(result.proposals.some((proposal) => proposal.relation === 'possible_conflict'), true)
      assert.equal(result.proposals.every((proposal) => proposal.next.includes('memory read')), true)
      assert.equal(await readFile(file, 'utf8'), before)
    })
  })

  test('read caps oversized markdown content', async () => {
    await withTempMemory(async (rootDir) => {
      await writeMemoryEntry({ rootDir, maxReadChars: 80 }, {
        scope: 'self',
        title: 'working-notes',
        content: 'x'.repeat(200),
      })

      const result = await readMemoryFile({ rootDir, maxReadChars: 80 }, {
        file: 'self/working-notes.md',
      })

      assert.equal(result.ok, true)
      assert.equal(result.truncated, true)
      assert.equal(result.content.length, 80)
      assert.equal(result.nextOffset, 80)
      assert.match(result.revision, /^[a-f0-9]{64}$/)
    })
  })

  test('search skips corrupt frontmatter and reports skippedCorrupt', async () => {
    await withTempMemory(async (rootDir) => {
      await mkdir(join(rootDir, 'memory', 'self'), { recursive: true })
      await writeFile(join(rootDir, 'memory', 'self', 'bad.md'), '---\nscope self\n---\nhello memory\n', 'utf8')
      await writeMemoryEntry({ rootDir }, {
        scope: 'self',
        title: 'good',
        content: 'hello memory',
      })

      const result = await searchMemoryEntries({ rootDir }, { keyword: 'memory' })

      assert.equal(result.ok, true)
      assert.equal(result.skippedCorrupt, 1)
      assert.deepEqual(result.matches.map((match) => match.file), ['self/good.md'])
    })
  })

  test('read rejects path escapes', async () => {
    await withTempMemory(async (rootDir) => {
      const result = await readMemoryFile({ rootDir }, { file: '../secret.md' })

      assert.equal(result.ok, false)
      assert.match(result.error, /not allowed/)
    })
  })

  test('list returns bounded metadata filtered by scope and ordered by updatedAt', async () => {
    await withTempMemory(async (rootDir) => {
      await writeMemoryEntry({
        rootDir,
        now: () => new Date('2026-07-05T00:00:00.000Z'),
      }, {
        scope: 'self',
        title: 'old',
        content: '旧线索',
      })
      await writeMemoryEntry({
        rootDir,
        now: () => new Date('2026-07-06T00:00:00.000Z'),
      }, {
        scope: 'self',
        title: 'new',
        content: '新线索',
      })
      await writeMemoryEntry({ rootDir }, {
        scope: 'topic',
        title: 'other',
        content: '其他主题',
      })

      const result = await listMemoryFiles({ rootDir }, { scope: 'self', limit: 1 })

      assert.equal(result.ok, true)
      assert.equal(result.total, 2)
      assert.equal(result.truncated, true)
      assert.equal(result.files.length, 1)
      assert.equal(result.files[0]!.file, 'self/new.md')
      assert.equal(result.files[0]!.scope, 'self')
      assert.equal(result.files[0]!.updatedAt, '2026-07-06T08:00:00.000+08:00')
      assert.ok(result.files[0]!.sizeBytes > 0)
    })
  })

  test('delete permanently removes valid files and reports missing or rejected paths', async () => {
    await withTempMemory(async (rootDir) => {
      await writeMemoryEntry({ rootDir }, {
        scope: 'self',
        title: 'old',
        content: '应该删除',
      })
      const outside = join(rootDir, 'outside.md')
      await writeFile(outside, 'keep', 'utf8')

      const result = await deleteMemoryFiles({ rootDir }, {
        files: ['self/old.md', 'self/missing.md', '../outside.md'],
      })

      assert.deepEqual(result.deleted, ['self/old.md'])
      assert.deepEqual(result.missing, ['self/missing.md'])
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0]!.file, '../outside.md')
      await assert.rejects(access(join(rootDir, 'memory', 'self', 'old.md')))
      assert.equal(await readFile(outside, 'utf8'), 'keep')
    })
  })

  test('ignores old files and replaces them on the next write', async () => {
    await withTempMemory(async (rootDir) => {
      await mkdir(join(rootDir, 'memory', 'self'), { recursive: true })
      await writeFile(
        join(rootDir, 'memory', 'self', 'legacy.md'),
        '---\nscope: self\ntitle: legacy\nupdatedAt: 2026-07-01T00:00:00.000Z\naliases: []\n---\n\n## 最近线索\n\n- 2026-07-01T00:00:00.000Z: wrong\n',
        'utf8',
      )
      const before = await readMemoryFile({ rootDir }, { file: 'self/legacy.md' })
      assert.deepEqual(before, { ok: false, error: 'memory file format is not supported' })
      assert.equal((await searchMemoryEntries({ rootDir }, { keyword: 'wrong' })).matches.length, 0)
      assert.equal((await listMemoryFiles({ rootDir })).skippedCorrupt, 1)

      await writeMemoryEntry(
        {
          rootDir,
          now: () => new Date('2026-07-02T00:00:00.000Z'),
          id: () => 'new-entry',
        },
        { scope: 'self', title: 'legacy', content: 'new format only' },
      )
      const after = await readMemoryFile({ rootDir }, { file: 'self/legacy.md' })
      assert.equal(after.ok, true)
      if (!after.ok) return
      assert.equal(after.entries[0]?.id, 'new-entry')
      assert.equal(after.entries[0]?.content, 'new format only')
      assert.doesNotMatch(after.content, /wrong/)
      assert.match(after.content, /formatVersion: 1/)
    })
  })

  test('compacts selected memory entries and preserves the rest', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `memory-${++nextId}`,
      }
      await writeMemoryEntry(options, { scope: 'self', title: 'notes', content: 'detail a' })
      await writeMemoryEntry(options, { scope: 'self', title: 'notes', content: 'detail b' })
      await writeMemoryEntry(options, { scope: 'self', title: 'notes', content: 'keep c' })
      const before = await readMemoryFile({ rootDir }, { file: 'self/notes.md' })
      assert.equal(before.ok, true)
      if (!before.ok) return

      const compacted = await compactMemoryEntries(options, {
        file: 'self/notes.md',
        entryIds: ['memory-1', 'memory-2'],
        expectedRevision: before.revision,
        content: 'combined',
      })
      const after = await readMemoryFile({ rootDir }, { file: 'self/notes.md' })
      assert.equal(after.ok, true)
      if (!after.ok) return
      assert.equal(compacted.entryId, 'memory-4')
      assert.deepEqual(after.entries.map((entry) => entry.id), ['memory-4', 'memory-1', 'memory-2', 'memory-3'])
      assert.equal(after.entries[0]?.tier, 'stable')
      assert.deepEqual(after.entries.slice(1, 3).map((entry) => entry.status), ['superseded', 'superseded'])
      assert.deepEqual(after.entries[0]?.supersedes, ['memory-1', 'memory-2'])
      assert.equal(after.entries[3]?.tier, 'recent')
      assert.match(after.content, /## 稳定记忆[\s\S]*id: memory-4[\s\S]*## 最近线索[\s\S]*id: memory-3/)

      await assert.rejects(
        deleteMemoryEntry(options, {
          file: 'self/notes.md',
          entryId: 'memory-1',
          expectedRevision: after.revision,
        }),
        (error: unknown) => error instanceof MemoryStoreError
          && error.code === 'invalid_selection'
          && /referenced by memory-4/.test(error.message),
      )
    })
  })

  test('applies bounded maintenance operations atomically and never discards stable memory', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `maint-${++nextId}`,
      }
      await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '先看代码' })
      await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '先看日志' })
      await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '一次性闲聊' })
      const before = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')

      const applied = await applyMemoryMaintenance(options, {
        file: 'self/methods.md',
        expectedRevision: before.revision,
        operations: [
          { action: 'merge', entryIds: ['maint-1', 'maint-2'], content: '判断问题时先看代码和实际日志' },
          { action: 'discard', entryId: 'maint-3', reason: '一次性内容' },
        ],
      })
      const after = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')

      assert.equal(applied.merged, 1)
      assert.equal(applied.discarded, 1)
      assert.equal(after.stableCount, 1)
      assert.equal(after.recentCount, 0)
      assert.equal(after.entries[0]?.content, '判断问题时先看代码和实际日志')
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/methods.md',
          expectedRevision: after.revision,
          operations: [{ action: 'discard', entryId: after.entries[0]!.id, reason: '不允许' }],
        }),
        /cannot discard stable entry/,
      )
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/methods.md',
          expectedRevision: after.revision,
          operations: [{ action: 'promote', entryId: after.entries[0]!.id, content: '重复总结' }],
        }),
        /cannot re-promote stable entry/,
      )

      await writeMemoryEntry(options, { scope: 'self', title: 'ephemeral', content: '唯一线索' })
      const ephemeral = await inspectMemoryFileForMaintenance({ rootDir }, 'self/ephemeral.md')
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/ephemeral.md',
          expectedRevision: ephemeral.revision,
          operations: [{ action: 'discard', entryId: ephemeral.entries[0]!.id, reason: '不能清空文件' }],
        }),
        /cannot empty a memory file/,
      )
    })
  })

  test('requires two distinct source messages before automatic promotion', async () => {
    await withTempMemory(async (rootDir) => {
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => 'evidence-1',
      }
      await writeMemoryEntry(options, {
        scope: 'self', title: 'evidence', content: '跨天仍然有用的方法', sourceMessageIds: [101],
      })
      let snapshot = await inspectMemoryFileForMaintenance({ rootDir }, 'self/evidence.md')
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/evidence.md',
          expectedRevision: snapshot.revision,
          operations: [{ action: 'promote', entryId: 'evidence-1', content: '稳定方法' }],
        }),
        /at least two distinct source messages/,
      )

      await writeMemoryEntry(options, {
        scope: 'self', title: 'evidence', content: '跨天仍然有用的方法', sourceMessageIds: [102],
      })
      snapshot = await inspectMemoryFileForMaintenance({ rootDir }, 'self/evidence.md')
      await applyMemoryMaintenance(options, {
        file: 'self/evidence.md',
        expectedRevision: snapshot.revision,
        operations: [{ action: 'promote', entryId: 'evidence-1', content: '稳定方法' }],
      })
      const after = await inspectMemoryFileForMaintenance({ rootDir }, 'self/evidence.md')
      assert.equal(after.entries[0]?.tier, 'stable')
    })
  })

  test('converts an obvious contradictory merge into disputed entries without deleting either fact', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `conflict-${++nextId}`,
      }
      await writeMemoryEntry(options, { scope: 'person', id: '10001', content: '主人喜欢喝手冲咖啡' })
      await writeMemoryEntry(options, { scope: 'person', id: '10001', content: '主人不喜欢喝手冲咖啡' })
      const snapshot = await inspectMemoryFileForMaintenance({ rootDir }, 'people/10001.md')

      const applied = await applyMemoryMaintenance(options, {
        file: 'people/10001.md',
        expectedRevision: snapshot.revision,
        operations: [{
          action: 'merge',
          entryIds: ['conflict-1', 'conflict-2'],
          content: '主人对手冲咖啡的偏好不确定',
        }],
      })
      const after = await inspectMemoryFileForMaintenance({ rootDir }, 'people/10001.md')

      assert.equal(applied.merged, 0)
      assert.equal(applied.disputed, 2)
      assert.deepEqual(after.entries.map((entry) => entry.id), ['conflict-1', 'conflict-2'])
      assert.deepEqual(after.entries.map((entry) => entry.status), ['disputed', 'disputed'])
    })
  })

  test('keeps disputed and superseded entries out of automatic discard, promotion, and merge', async () => {
    await withTempMemory(async (rootDir) => {
      let nextId = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `lifecycle-${++nextId}`,
      }
      await writeMemoryEntry(options, { scope: 'self', title: 'lifecycle', content: '待核实事实' })
      await writeMemoryEntry(options, { scope: 'self', title: 'lifecycle', content: '替代事实' })
      let snapshot = await readMemoryFile({ rootDir }, { file: 'self/lifecycle.md' })
      assert.equal(snapshot.ok, true)
      if (!snapshot.ok) return
      await markMemoryEntryDisputed(options, {
        file: 'self/lifecycle.md', entryId: 'lifecycle-2', expectedRevision: snapshot.revision,
      })
      snapshot = await readMemoryFile({ rootDir }, { file: 'self/lifecycle.md' })
      assert.equal(snapshot.ok, true)
      if (!snapshot.ok) return
      await supersedeMemoryEntry(options, {
        file: 'self/lifecycle.md',
        entryId: 'lifecycle-1',
        replacementEntryId: 'lifecycle-2',
        expectedRevision: snapshot.revision,
      })
      const before = await inspectMemoryFileForMaintenance({ rootDir }, 'self/lifecycle.md')

      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/lifecycle.md',
          expectedRevision: before.revision,
          operations: [{ action: 'promote', entryId: 'lifecycle-1', content: '不应晋升' }],
        }),
        /only promote recent active entries/,
      )
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/lifecycle.md',
          expectedRevision: before.revision,
          operations: [{ action: 'discard', entryId: 'lifecycle-2', reason: '不应删除 disputed' }],
        }),
        /only discard recent active entries/,
      )
      await assert.rejects(
        applyMemoryMaintenance(options, {
          file: 'self/lifecycle.md',
          expectedRevision: before.revision,
          operations: [{
            action: 'merge',
            entryIds: ['lifecycle-1', 'lifecycle-2'],
            content: '不应合并',
          }],
        }),
        /only merge active entries/,
      )
    })
  })
})
