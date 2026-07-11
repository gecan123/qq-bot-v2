import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zod from 'zod'
import { createMemoryTool, memoryTool } from './memory.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

async function withTempMemory<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), 'memory-tool-'))
  try {
    return await fn(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

describe('memory tool schema', () => {
  test('accepts self write without target id', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'self',
      title: 'working-notes',
      content: '做本地记忆要保持输出有上限',
    })
    assert.equal(parsed.success, true)
  })

  test('accepts person write with id', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'person',
      id: 12345,
      content: '喜欢短句',
    })
    assert.equal(parsed.success, true)
  })

  test('rejects empty content', () => {
    const parsed = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'self',
      content: '',
    })
    assert.equal(parsed.success, false)
  })

  test('accepts bounded list and delete actions', () => {
    assert.equal(memoryTool.schema.safeParse({
      action: 'list',
      scope: 'self',
      limit: 50,
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'delete',
      files: ['self/old.md'],
    }).success, true)
  })

  test('rejects empty or escaping delete paths', () => {
    assert.equal(memoryTool.schema.safeParse({ action: 'delete', files: [] }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'delete',
      files: ['../old.md'],
    }).success, false)
  })

  test('schema serializes cleanly to JSON Schema', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(memoryTool.schema))
  })
})

describe('memory tool execute', () => {
  test('writes, searches, and reads self memory from the configured root', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({
        workspaceDir,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      })

      const written = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'self',
        title: 'working-notes',
        content: 'Markdown memory keeps replay deterministic',
      }, makeCtx())).content as string) as { ok: boolean; file: string }
      assert.equal(written.ok, true)
      assert.equal(written.file, 'self/working-notes.md')

      const searched = JSON.parse((await tool.execute({
        action: 'search',
        keyword: 'replay',
        limit: 5,
      }, makeCtx())).content as string) as { ok: boolean; matches: { file: string; snippet: string }[] }
      assert.equal(searched.ok, true)
      assert.equal(searched.matches[0]!.file, 'self/working-notes.md')
      assert.match(searched.matches[0]!.snippet, /replay/)

      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'self/working-notes.md',
      }, makeCtx())).content as string) as { ok: boolean; content: string }
      assert.equal(read.ok, true)
      assert.match(read.content, /Markdown memory keeps replay deterministic/)
    })
  })

  test('returns structured error when person write omits id', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({ workspaceDir })
      const result = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'person',
        content: '缺 id 不应该写入',
      }, makeCtx())).content as string) as { ok: boolean; error: string }

      assert.equal(result.ok, false)
      assert.match(result.error, /requires id/)
    })
  })

  test('lists and permanently deletes memory files', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({ workspaceDir })
      await tool.execute({
        action: 'write',
        scope: 'self',
        title: 'old',
        content: '待删除',
      }, makeCtx())

      const listed = JSON.parse((await tool.execute({
        action: 'list',
        scope: 'self',
        limit: 50,
      }, makeCtx())).content as string) as { ok: boolean; files: { file: string }[] }
      assert.equal(listed.ok, true)
      assert.deepEqual(listed.files.map((entry) => entry.file), ['self/old.md'])

      const deleted = JSON.parse((await tool.execute({
        action: 'delete',
        files: ['self/old.md'],
      }, makeCtx())).content as string) as { ok: boolean; deleted: string[] }
      assert.equal(deleted.ok, true)
      assert.deepEqual(deleted.deleted, ['self/old.md'])

      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'self/old.md',
      }, makeCtx())).content as string) as { ok: boolean; error: string }
      assert.equal(read.ok, false)
      assert.match(read.error, /not found/)
    })
  })

  test('updates, deletes, and compacts entries through the typed tool', async () => {
    await withTempMemory(async (workspaceDir) => {
      let nextId = 0
      const tool = createMemoryTool({
        workspaceDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `memory-${++nextId}`,
      })
      for (const content of ['wrong', 'duplicate', 'keep']) {
        await tool.execute({ action: 'write', scope: 'self', title: 'notes', content }, makeCtx())
      }
      const read = async () => JSON.parse((await tool.execute({
        action: 'read',
        file: 'self/notes.md',
      }, makeCtx())).content as string) as { revision: string; entries: Array<{ id: string }> }

      let snapshot = await read()
      const updated = JSON.parse((await tool.execute({
        action: 'update_entry',
        file: 'self/notes.md',
        entryId: 'memory-1',
        expectedRevision: snapshot.revision,
        content: 'corrected',
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(updated.ok, true)

      snapshot = await read()
      const compacted = JSON.parse((await tool.execute({
        action: 'compact',
        file: 'self/notes.md',
        entryIds: ['memory-1', 'memory-2'],
        expectedRevision: snapshot.revision,
        content: 'combined',
      }, makeCtx())).content as string) as { ok: boolean; entryId: string }
      assert.equal(compacted.ok, true)
      assert.equal(compacted.entryId, 'memory-4')

      snapshot = await read()
      const deleted = JSON.parse((await tool.execute({
        action: 'delete_entry',
        file: 'self/notes.md',
        entryId: 'memory-3',
        expectedRevision: snapshot.revision,
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(deleted.ok, true)
    })
  })
})
