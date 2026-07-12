import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  createInMemoryTaskRegistry,
  createPersistentTaskRegistry,
} from './background-task-registry.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qq-bot-bg-tasks-'))
  tempDirs.push(dir)
  return join(dir, 'nested', 'tasks.json')
}

describe('background task registry', () => {
  test('persists completed task metadata and JSON result across registry instances', () => {
    const path = tempStatePath()
    let now = new Date('2026-07-12T00:00:00.000Z')
    const first = createPersistentTaskRegistry({
      path,
      now: () => now,
      idFactory: () => 'bg_fixed',
    }).registry
    const task = first.register({
      toolName: 'fetch_content',
      description: 'fetch example',
      recovery: { kind: 'fetch_url', payload: { url: 'https://example.com' } },
    })
    now = new Date('2026-07-12T00:00:05.000Z')
    first.complete(task.id, { summary: 'done', data: { result: 'ok' } })

    const reloaded = createPersistentTaskRegistry({ path, now: () => now })
    const stored = reloaded.registry.get(task.id)

    assert.equal(reloaded.interruptedAtStartup.length, 0)
    assert.equal(reloaded.recoverableAtStartup.length, 0)
    assert.equal(stored?.status, 'completed')
    assert.equal(stored?.startedAt.toISOString(), '2026-07-12T00:00:00.000Z')
    assert.equal(stored?.completedAt?.toISOString(), '2026-07-12T00:00:05.000Z')
    assert.deepEqual(stored?.resultData, { result: 'ok' })
    assert.deepEqual(stored?.recovery, {
      kind: 'fetch_url',
      payload: { url: 'https://example.com' },
    })
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number }).schemaVersion, 1)
  })

  test('marks stale running tasks interrupted exactly once after restart', () => {
    const path = tempStatePath()
    const first = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      idFactory: () => 'bg_running',
    }).registry
    first.register({ toolName: 'generate_image', description: 'generate cat' })

    const restarted = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:01:00.000Z'),
    })
    assert.equal(restarted.interruptedAtStartup.length, 1)
    assert.equal(restarted.interruptedAtStartup[0]?.status, 'interrupted')
    assert.equal(restarted.registry.get('bg_running')?.error, 'process_restarted_before_completion')

    const restartedAgain = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:02:00.000Z'),
    })
    assert.equal(restartedAgain.interruptedAtStartup.length, 0)
    assert.equal(restartedAgain.registry.get('bg_running')?.status, 'interrupted')
  })

  test('keeps running tasks with recovery descriptors available to a durable runner', () => {
    const path = tempStatePath()
    const first = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      idFactory: () => 'scheduled',
    }).registry
    first.register({
      toolName: 'schedule',
      description: 'wake later',
      recovery: {
        kind: 'scheduled_wake.v1',
        payload: { dueAt: '2026-07-12T00:10:00.000Z', reason: 'review task' },
      },
    })

    const restarted = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:01:00.000Z'),
    })

    assert.equal(restarted.interruptedAtStartup.length, 0)
    assert.equal(restarted.recoverableAtStartup.length, 1)
    assert.equal(restarted.registry.get('scheduled')?.status, 'running')
  })

  test('terminal transitions are idempotent and cannot overwrite the first result', () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'one' })
    const task = registry.register({ toolName: 'test', description: 'test' })
    registry.complete(task.id, { summary: 'first', data: { value: 1 } })
    registry.fail(task.id, 'late failure')
    registry.complete(task.id, { summary: 'second', data: { value: 2 } })

    assert.equal(registry.get(task.id)?.status, 'completed')
    assert.equal(registry.get(task.id)?.resultSummary, 'first')
    assert.deepEqual(registry.get(task.id)?.resultData, { value: 1 })
  })

  test('cancel moves only a running task into a terminal state', () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'cancel-me' })
    const task = registry.register({ toolName: 'test', description: 'test' })

    assert.equal(registry.cancel(task.id, 'operator_cancelled'), true)
    assert.equal(registry.cancel(task.id), false)
    assert.equal(registry.get(task.id)?.status, 'cancelled')
    assert.equal(registry.get(task.id)?.error, 'operator_cancelled')
  })
})
