import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
      assert.match(raw, /updatedAt: 2026-06-27T00:00:00.000Z/)
      assert.match(raw, /- 2026-06-27T00:00:00.000Z: 以后做本地记忆优先保持 tool result 有上限/)
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
      assert.ok(result.content.length <= 120)
      assert.match(result.content, /truncated/)
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
})
