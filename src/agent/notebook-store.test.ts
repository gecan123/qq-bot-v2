import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
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

describe('notebook store', () => {
  test('writes an evolving note under a stable topic and kind', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')

    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-store-'))
    try {
      const entry = await store.appendNotebookRecord({
        rootDir,
        now: () => new Date('2026-07-13T02:00:00.000Z'),
        id: () => 'note-1',
      }, {
        kind: 'research',
        topic: 'Agent Context',
        content: '先验证 compaction 的失败路径。',
      })

      assert.deepEqual(entry, {
        id: 'note-1',
        kind: 'research',
        topic: 'Agent Context',
        content: '先验证 compaction 的失败路径。',
        createdAt: '2026-07-13T10:00:00.000+08:00',
      })
      const path = join(rootDir, 'notebook', 'research', '2026-07.md')
      await access(path)
      const raw = await readFile(path, 'utf8')
      assert.match(raw, /^# Research Notebook 2026-07/m)
      assert.match(raw, /topic: Agent Context/)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('filters and searches notes by topic and kind', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-query-'))
    try {
      const now = () => new Date('2026-07-13T02:00:00.000Z')
      let id = 0
      const options = { rootDir, now, id: () => `note-${++id}` }
      await store.appendNotebookRecord(options, {
        kind: 'research', topic: 'Agent Context', content: '验证 replay 不变量。',
      })
      await store.appendNotebookRecord(options, {
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

  test('updates, compacts, and deletes notes with revision protection', async () => {
    const store = await import('./notebook-store.js').catch(() => null)
    assert.ok(store, 'notebook store module should exist')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-mutate-'))
    try {
      let id = 0
      const options = {
        rootDir,
        now: () => new Date('2026-07-13T02:00:00.000Z'),
        id: () => `note-${++id}`,
      }
      await store.appendNotebookRecord(options, {
        kind: 'market', topic: 'BTC 周期', content: '观察流动性。',
      })
      await store.appendNotebookRecord(options, {
        kind: 'market', topic: 'BTC 周期', content: '补充失效条件。',
      })
      await store.appendNotebookRecord(options, {
        kind: 'market', topic: 'ETH', content: '观察升级。',
      })

      const first = await store.readNotebookRecordSnapshot({ rootDir }, 'note-1')
      assert.ok(first)
      const updated = await store.updateNotebookRecord({
        rootDir,
        entryId: 'note-1',
        expectedRevision: first.revision,
        content: '观察美元流动性。',
      })
      assert.equal(updated.entry.content, '观察美元流动性。')

      const second = await store.readNotebookRecordSnapshot({ rootDir }, 'note-2')
      assert.ok(second)
      const compacted = await store.compactNotebookRecords({
        ...options,
        ids: ['note-1', 'note-2'],
        expectedRevision: second.revision,
        content: 'BTC 周期观察需要同时跟踪美元流动性和失效条件。',
      })
      assert.deepEqual(compacted.compactedIds, ['note-1', 'note-2'])
      assert.equal(compacted.entry.topic, 'BTC 周期')

      const third = await store.readNotebookRecordSnapshot({ rootDir }, 'note-3')
      assert.ok(third)
      await assert.rejects(
        store.deleteNotebookRecord({ rootDir, entryId: 'note-3', expectedRevision: first.revision }),
        (error: unknown) => error instanceof store.NotebookStoreError && error.code === 'revision_conflict',
      )
      const deleted = await store.deleteNotebookRecord({
        rootDir, entryId: 'note-3', expectedRevision: third.revision,
      })
      assert.equal(deleted.id, 'note-3')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('serializes append and revision mutation for the same notebook month', async () => {
    const store = await import('./notebook-store.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'notebook-atomic-'))
    try {
      const now = () => new Date('2026-07-13T02:00:00.000Z')
      await store.appendNotebookRecord({ rootDir, now, id: () => 'note-initial' }, {
        kind: 'research', topic: 'Atomic', content: 'initial note',
      })
      const initial = await store.readNotebookRecordSnapshot({ rootDir }, 'note-initial')
      assert.ok(initial)
      const gated = createGatedCoordinator()
      const append = store.appendNotebookRecord({
        rootDir,
        now,
        id: () => 'note-appended',
        workspaceStateCoordinator: gated.coordinator,
      }, {
        kind: 'research', topic: 'Atomic', content: 'appended note',
      })
      await gated.entered
      const update = store.updateNotebookRecord({
        rootDir,
        entryId: 'note-initial',
        expectedRevision: initial.revision,
        content: 'stale update',
        workspaceStateCoordinator: gated.coordinator,
      }).then(() => null, (error: unknown) => error)

      for (let attempt = 0; attempt < 20 && gated.resourceKeys.length < 2; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const requestedKeys = [...gated.resourceKeys]
      gated.release()
      await append
      const updateError = await update

      assert.deepEqual(requestedKeys, ['notebook:research/2026-07.md', 'notebook:research/2026-07.md'])
      assert.equal(updateError instanceof store.NotebookStoreError && updateError.code === 'revision_conflict', true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
