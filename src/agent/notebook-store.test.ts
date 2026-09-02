import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
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

function legacyEntry(input: {
  id: string
  kind: string
  topic: string
  createdAt: string
  content: string
}): string {
  return [
    '<!-- notebook-entry',
    `id: ${input.id}`,
    `kind: ${input.kind}`,
    `topic: ${input.topic}`,
    `createdAt: ${input.createdAt}`,
    '-->',
    input.content,
    '<!-- /notebook-entry -->',
    '',
  ].join('\n')
}

describe('notebook store', () => {
  test('checkpoints one current note per stable topic instead of appending', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')

    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-store-'))
    try {
      let now = new Date('2026-07-13T02:00:00.000Z')
      let idCalls = 0
      const options = {
        rootDir,
        now: () => now,
        id: () => `note-${++idCalls}`,
      }
      const first = await store.checkpointNotebookRecord(options, {
        kind: 'research',
        topic: 'Agent Context',
        content: '先验证 compaction 的失败路径。',
      })

      assert.equal(first.created, true)
      assert.equal(first.changed, true)
      assert.equal(first.entry.id, 'note-1')
      assert.equal(first.entry.updatedAt, '2026-07-13T10:00:00.000+08:00')

      now = new Date('2026-07-14T02:00:00.000Z')
      const second = await store.checkpointNotebookRecord(options, {
        kind: 'research',
        topic: 'agent context',
        content: '已经验证 compaction 失败路径，下一步检查 replay。',
      })

      assert.equal(second.created, false)
      assert.equal(second.changed, true)
      assert.equal(second.entry.id, 'note-1')
      assert.equal(second.entry.topic, 'Agent Context')
      assert.equal(second.entry.updatedAt, '2026-07-14T10:00:00.000+08:00')
      assert.deepEqual(second.consolidatedIds, [])
      assert.equal(idCalls, 1)

      const unchanged = await store.checkpointNotebookRecord(options, {
        kind: 'research',
        topic: 'Agent Context',
        content: '已经验证 compaction 失败路径，下一步检查 replay。',
      })
      assert.equal(unchanged.changed, false)
      assert.equal(unchanged.entry.updatedAt, second.entry.updatedAt)

      const path = join(rootDir, 'notebook', 'research', '2026-07.md')
      await access(path)
      const raw = await readFile(path, 'utf8')
      assert.equal(raw.match(/<!-- notebook-entry/g)?.length, 1)
      assert.match(raw, /updatedAt: 2026-07-14T10:00:00\.000\+08:00/)
      assert.match(raw, /下一步检查 replay/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('filters and searches only the current note for each topic', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-query-'))
    try {
      const now = () => new Date('2026-07-13T02:00:00.000Z')
      let id = 0
      const options = { rootDir, now, id: () => `note-${++id}` }
      await store.checkpointNotebookRecord(options, {
        kind: 'research', topic: 'Agent Context', content: '验证 replay 不变量。',
      })
      await store.checkpointNotebookRecord(options, {
        kind: 'reading', topic: '三体', content: '读到黑暗森林。',
      })

      const listed = await store.listNotebookRecords({ rootDir }, {
        kind: 'research', topic: 'agent context', limit: 10,
      })
      assert.deepEqual(listed.entries.map((entry: { id: string }) => entry.id), ['note-1'])

      const searched = await store.searchNotebookRecords({ rootDir }, {
        query: '黑暗森林', limit: 10,
      })
      assert.deepEqual(searched.entries.map((entry: { id: string }) => entry.id), ['note-2'])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('consolidates legacy duplicate entries when the topic is next checkpointed', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-legacy-'))
    try {
      const directory = join(rootDir, 'notebook', 'general')
      await mkdir(directory, { recursive: true })
      const path = join(directory, '2026-07.md')
      await writeFile(path, [
        '# General Notebook 2026-07',
        '',
        legacyEntry({
          id: 'note-old',
          kind: 'general',
          topic: '运行记录',
          createdAt: '2026-07-13T10:00:00.000+08:00',
          content: '第一次说准备停止。',
        }),
        legacyEntry({
          id: 'note-new',
          kind: 'general',
          topic: '运行记录',
          createdAt: '2026-07-13T11:00:00.000+08:00',
          content: '第二次说准备停止。',
        }),
      ].join('\n'), 'utf8')

      const result = await store.checkpointNotebookRecord({
        rootDir,
        now: () => new Date('2026-07-13T04:00:00.000Z'),
      }, {
        kind: 'general',
        topic: '运行记录',
        content: '当前没有未完成方向，等待真实事件。',
      })

      assert.equal(result.created, false)
      assert.equal(result.changed, true)
      assert.equal(result.entry.id, 'note-new')
      assert.deepEqual(result.consolidatedIds, ['note-old'])
      const raw = await readFile(path, 'utf8')
      assert.equal(raw.match(/<!-- notebook-entry/g)?.length, 1)
      assert.doesNotMatch(raw, /第一次说准备停止/)
      assert.match(raw, /等待真实事件/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('serializes concurrent checkpoints for the same topic', async () => {
    const store = await import('./notebook-store.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-atomic-'))
    try {
      const gated = createGatedCoordinator()
      let id = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-13T02:00:00.000Z'),
        id: () => `note-${++id}`,
        workspaceStateCoordinator: gated.coordinator,
      }
      const first = store.checkpointNotebookRecord(options, {
        kind: 'research', topic: 'Atomic', content: '第一版当前状态。',
      })
      await gated.entered
      const second = store.checkpointNotebookRecord(options, {
        kind: 'research', topic: 'atomic', content: '第二版当前状态。',
      })

      for (let attempt = 0; attempt < 20 && gated.resourceKeys.length < 2; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const requestedKeys = [...gated.resourceKeys]
      gated.release()
      await Promise.all([first, second])

      assert.deepEqual(requestedKeys, ['notebook', 'notebook'])
      const listed = await store.listNotebookRecords({ rootDir }, { kind: 'research', topic: 'Atomic' })
      assert.equal(listed.entries.length, 1)
      assert.equal(listed.entries[0]?.content, '第二版当前状态。')
      assert.equal(id, 1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('preserves different topics checkpointed concurrently into one monthly file', async () => {
    const store = await import('./notebook-store.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-parallel-topics-'))
    try {
      const gated = createGatedCoordinator()
      let id = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-13T02:00:00.000Z'),
        id: () => `note-${++id}`,
        workspaceStateCoordinator: gated.coordinator,
      }
      const first = store.checkpointNotebookRecord(options, {
        kind: 'research', topic: '主题甲', content: '主题甲的当前状态。',
      })
      await gated.entered
      const second = store.checkpointNotebookRecord(options, {
        kind: 'research', topic: '主题乙', content: '主题乙的当前状态。',
      })

      for (let attempt = 0; attempt < 20 && gated.resourceKeys.length < 2; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const requestedKeys = [...gated.resourceKeys]
      gated.release()
      await Promise.all([first, second])

      assert.deepEqual(requestedKeys, ['notebook', 'notebook'])
      const listed = await store.listNotebookRecords({ rootDir }, { kind: 'research' })
      assert.deepEqual(new Set(listed.entries.map((entry: { topic: string }) => entry.topic)), new Set(['主题甲', '主题乙']))
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('bounds general topics while keeping existing topics updateable', async () => {
    const store = await import('./notebook-store.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-general-limit-'))
    try {
      let id = 0
      const options = {
        rootDir,
        now: () => new Date('2026-09-01T02:00:00.000Z'),
        id: () => `note-${++id}`,
      }
      for (const topic of ['停止', '最终停止', '真正的停止', '最终状态', '最终承认']) {
        await store.checkpointNotebookRecord(options, {
          kind: 'general', topic, content: `${topic}的当前状态。`,
        })
      }

      await assert.rejects(
        store.checkpointNotebookRecord(options, {
          kind: 'general', topic: '最终决定', content: '再次创建一个近义状态主题。',
        }),
        (error: unknown) => (
          error instanceof store.NotebookStoreError
          && error.code === 'topic_limit_reached'
          && /停止.*最终承认/.test(error.message)
        ),
      )

      const updated = await store.checkpointNotebookRecord(options, {
        kind: 'general', topic: '停止', content: '已有主题仍然可以更新。',
      })
      assert.equal(updated.created, false)
      assert.equal(updated.entry.content, '已有主题仍然可以更新。')
      const listed = await store.listNotebookRecords({ rootDir }, { kind: 'general' })
      assert.equal(listed.entries.length, 5)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
