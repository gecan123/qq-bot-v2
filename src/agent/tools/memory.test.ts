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
      sourceMessageIds: [12],
    })
    assert.equal(parsed.success, true)
  })

  test('requires message-row evidence for person and group writes', () => {
    assert.equal(memoryTool.schema.safeParse({
      action: 'write', scope: 'person', id: 10001, content: '对方喜欢无糖拿铁',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'write', scope: 'group', id: 20001, content: '群里只允许被提及时回复',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'write', scope: 'person', id: 10001, content: '对方喜欢无糖拿铁', sourceMessageIds: [12],
    }).success, true)
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
    assert.equal(memoryTool.schema.safeParse({
      action: 'promote_entry',
      file: 'self/notes.md',
      entryId: 'entry-1',
      expectedRevision: 'a'.repeat(64),
      content: '稳定结论',
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'mark_disputed',
      file: 'self/notes.md',
      entryId: 'entry-1',
      expectedRevision: 'a'.repeat(64),
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'supersede_entry',
      file: 'self/notes.md',
      entryId: 'entry-1',
      replacementEntryId: 'entry-2',
      expectedRevision: 'a'.repeat(64),
    }).success, true)
    const untrusted = memoryTool.schema.safeParse({
      action: 'write',
      scope: 'self',
      content: '不要让模型直接指定可信度',
      trust: 'high',
    })
    assert.equal(untrusted.success, true)
    if (untrusted.success) assert.equal('trust' in (untrusted.data as object), false)
  })

  test('validates recall scope and id combinations', () => {
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '喜欢什么',
      scope: 'person',
      id: 12345,
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '群里有什么约定',
      scope: 'group',
      id: '67890',
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '喜欢什么',
      scope: 'person',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '群里有什么约定',
      scope: 'group',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '自己的经验',
      scope: 'self',
      id: '12345',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '主题资料',
      scope: 'topic',
      id: '12345',
    }).success, false)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '宽泛探索',
    }).success, true)
    assert.equal(memoryTool.schema.safeParse({
      action: 'recall',
      query: '不能带无归属目标',
      id: '12345',
    }).success, false)
    for (const id of ['', '   ', '../other', 'a/b', 'a\\b', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(memoryTool.schema.safeParse({
        action: 'recall',
        query: '目标格式校验',
        scope: 'person',
        id,
      }).success, false, `expected recall id ${String(id)} to be rejected`)
    }
  })

  test('description guides contextual recall without encouraging duplicate lookup', () => {
    assert.match(memoryTool.description, /上下文不足/)
    assert.match(memoryTool.description, /旧事.*偏好.*稳定事实.*经验/)
    assert.match(memoryTool.description, /不要重复 recall/)
    assert.match(memoryTool.description, /search.*宽泛.*文件/)
    assert.match(memoryTool.description, /person\/group recall.*QQ.*群 id/)
  })

  test('rejects topic write without stable title at execution boundary', async () => {
    await withTempMemory(async (rootDir) => {
      const tool = createMemoryTool({ workspaceDir: rootDir })
      const result = await tool.execute({
        action: 'write',
        scope: 'topic',
        content: '今日速记',
      }, makeCtx())
      const payload = JSON.parse(result.content as string)

      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'invalid_input')
      assert.match(payload.error, /requires a stable title/)
    })
  })

  test('queues maintenance only when a new recent entry is created', async () => {
    await withTempMemory(async (rootDir) => {
      const queued: string[] = []
      const tool = createMemoryTool({
        workspaceDir: rootDir,
        maintenance: {
          enqueue(file) {
            queued.push(file)
            return { ok: true, queued: true, coalesced: false }
          },
          async drain() {},
        },
      })
      const input = {
        action: 'write' as const,
        scope: 'self' as const,
        title: 'methods',
        content: '先看真实日志',
      }
      await tool.execute(input, makeCtx())
      await tool.execute(input, makeCtx())

      assert.deepEqual(queued, ['self/methods.md'])
    })
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
  test('passes recall id through and only returns the selected person', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({ workspaceDir })
      await tool.execute({
        action: 'write', scope: 'person', id: '10001', content: '喜欢无糖拿铁', sourceMessageIds: [1],
      }, makeCtx())
      await tool.execute({
        action: 'write', scope: 'person', id: '10002', content: '喜欢无糖拿铁', sourceMessageIds: [2],
      }, makeCtx())

      const recalled = JSON.parse((await tool.execute({
        action: 'recall',
        query: '无糖拿铁',
        scope: 'person',
        id: '10002',
      }, makeCtx())).content as string) as { ok: boolean; matches: Array<{ file: string }> }

      assert.equal(recalled.ok, true)
      assert.deepEqual(recalled.matches.map((match) => match.file), ['people/10002.md'])
    })
  })

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
        sourceMessageIds: [1],
      }, makeCtx())).content as string) as { ok: boolean; error: string }

      assert.equal(result.ok, false)
      assert.match(result.error, /requires id/)
    })
  })

  test('rejects person evidence rows that do not exist', async () => {
    await withTempMemory(async (workspaceDir) => {
      const tool = createMemoryTool({
        workspaceDir,
        async validateSourceMessageIds(query) {
          assert.deepEqual(query, {
            sourceMessageIds: [404],
            scope: 'person',
            id: '10001',
          })
          return query.sourceMessageIds.filter((id) => id !== 404)
        },
      })
      const result = await tool.execute({
        action: 'write',
        scope: 'person',
        id: 10001,
        content: '对方是公务员',
        sourceMessageIds: [404],
      }, makeCtx())

      assert.deepEqual(result.outcome, {
        ok: false,
        code: 'invalid_evidence',
        error: 'sourceMessageIds contain unknown message rows: 404',
        progress: false,
        retryClass: 'immediate',
      })
    })
  })

  test('correct_entry atomically supersedes an old fact with an evidenced replacement', async () => {
    await withTempMemory(async (workspaceDir) => {
      let nextId = 0
      const tool = createMemoryTool({
        workspaceDir,
        id: () => `memory-${++nextId}`,
        async validateSourceMessageIds(query) { return query.sourceMessageIds },
      })
      await tool.execute({
        action: 'write', scope: 'person', id: 10001, content: '对方是程序员', sourceMessageIds: [10],
      }, makeCtx())
      const before = JSON.parse((await tool.execute({
        action: 'read', file: 'people/10001.md',
      }, makeCtx())).content as string) as { revision: string }

      const corrected = await tool.execute({
        action: 'correct_entry',
        file: 'people/10001.md',
        entryId: 'memory-1',
        expectedRevision: before.revision,
        content: '对方是公务员，owner 已明确纠正',
        sourceMessageIds: [11],
      }, makeCtx())
      const payload = JSON.parse(corrected.content as string) as {
        ok: boolean
        oldEntryId: string
        replacementEntryId: string
      }
      assert.equal(payload.ok, true)
      assert.equal(payload.oldEntryId, 'memory-1')
      assert.equal(payload.replacementEntryId, 'memory-2')
      assert.deepEqual(corrected.outcome, { ok: true, code: 'corrected', progress: true })

      const after = JSON.parse((await tool.execute({
        action: 'read', file: 'people/10001.md',
      }, makeCtx())).content as string) as {
        entries: Array<{ id: string; status: string; content: string; sourceMessageIds: number[]; supersedes: string[] }>
      }
      assert.equal(after.entries.find((entry) => entry.id === 'memory-1')?.status, 'superseded')
      const replacement = after.entries.find((entry) => entry.id === 'memory-2')
      assert.equal(replacement?.content, '对方是公务员，owner 已明确纠正')
      assert.deepEqual(replacement?.sourceMessageIds, [11])
      assert.deepEqual(replacement?.supersedes, ['memory-1'])
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
      const promoted = JSON.parse((await tool.execute({
        action: 'promote_entry',
        file: 'self/notes.md',
        entryId: 'memory-3',
        expectedRevision: snapshot.revision,
        content: 'stable keep',
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(promoted.ok, true)

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

  test('marks disputed and superseded entries through revision-checked actions', async () => {
    await withTempMemory(async (workspaceDir) => {
      let nextId = 0
      const tool = createMemoryTool({
        workspaceDir,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        id: () => `memory-${++nextId}`,
      })
      await tool.execute({ action: 'write', scope: 'self', title: 'facts', content: '旧事实' }, makeCtx())
      await tool.execute({ action: 'write', scope: 'self', title: 'facts', content: '新事实' }, makeCtx())
      const read = async () => JSON.parse((await tool.execute({
        action: 'read',
        file: 'self/facts.md',
      }, makeCtx())).content as string) as {
        revision: string
        entries: Array<{ id: string; status: string; supersedes: string[] }>
      }

      let snapshot = await read()
      const disputed = JSON.parse((await tool.execute({
        action: 'mark_disputed',
        file: 'self/facts.md',
        entryId: 'memory-1',
        expectedRevision: snapshot.revision,
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(disputed.ok, true)

      snapshot = await read()
      const superseded = JSON.parse((await tool.execute({
        action: 'supersede_entry',
        file: 'self/facts.md',
        entryId: 'memory-1',
        replacementEntryId: 'memory-2',
        expectedRevision: snapshot.revision,
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(superseded.ok, true)

      snapshot = await read()
      assert.equal(snapshot.entries.find((entry) => entry.id === 'memory-1')?.status, 'superseded')
      assert.deepEqual(snapshot.entries.find((entry) => entry.id === 'memory-2')?.supersedes, ['memory-1'])
    })
  })
})
