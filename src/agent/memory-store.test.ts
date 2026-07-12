import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compactMemoryEntries,
  deleteMemoryFiles,
  listMemoryFiles,
  readMemoryFile,
  searchMemoryEntries,
  writeMemoryEntry,
} from './memory-store.js'

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
      assert.deepEqual(after.entries.map((entry) => entry.id), ['memory-4', 'memory-3'])
    })
  })
})
