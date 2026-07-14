import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createInMemoryTaskRegistry, createPersistentTaskRegistry } from './background-task-registry.js'
import { createDurableWakeScheduler } from './durable-wake-scheduler.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fakeTimer() {
  let next = 1
  const callbacks = new Map<number, () => void>()
  const delays: number[] = []
  return {
    callbacks,
    delays,
    port: {
      setTimeout(callback: () => void, delayMs: number) {
        const id = next++
        callbacks.set(id, callback)
        delays.push(delayMs)
        return id
      },
      clearTimeout(handle: unknown) {
        callbacks.delete(handle as number)
      },
    },
  }
}

describe('durable wake scheduler', () => {
  test('persists, fires, completes the registry task, and emits a stable event', () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'wake-1' })
    const events = new InMemoryEventQueue<BotEvent>()
    const timer = fakeTimer()
    const now = new Date('2026-07-12T00:00:00.000Z')
    const scheduler = createDurableWakeScheduler({
      registry,
      eventQueue: events,
      now: () => now,
      timer: timer.port,
    })

    const wake = scheduler.schedule({ delaySeconds: 60, reason: '检查后台研究' })
    assert.equal(wake.id, 'wake-1')
    assert.deepEqual(timer.delays, [60_000])
    assert.equal(registry.get(wake.id)?.recovery?.kind, 'scheduled_wake.v1')

    timer.callbacks.values().next().value?.()

    assert.equal(registry.get(wake.id)?.status, 'completed')
    assert.deepEqual(events.dequeue(), {
      type: 'scheduled_wake',
      scheduleId: 'wake-1',
      name: '检查后台研究',
      scheduleKind: 'at',
      scheduledFor: new Date('2026-07-12T00:01:00.000Z'),
      intention: '检查后台研究',
      runCount: 1,
    })
  })

  test('cancel clears the timer and leaves a durable cancelled task', () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'wake-2' })
    const timer = fakeTimer()
    const scheduler = createDurableWakeScheduler({
      registry,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      timer: timer.port,
    })
    scheduler.schedule({ delaySeconds: 60, reason: 'later' })

    assert.equal(scheduler.cancel('wake-2'), true)
    assert.equal(timer.callbacks.size, 0)
    assert.equal(registry.get('wake-2')?.status, 'cancelled')
  })

  test('re-arms a recoverable schedule after a process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-bot-wake-'))
    tempDirs.push(dir)
    const path = join(dir, 'tasks.json')
    const firstTimer = fakeTimer()
    const firstRegistry = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      idFactory: () => 'wake-restart',
    }).registry
    const first = createDurableWakeScheduler({
      registry: firstRegistry,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      timer: firstTimer.port,
    })
    first.schedule({ delaySeconds: 600, reason: 'resume me' })
    first.stop()

    const reloaded = createPersistentTaskRegistry({
      path,
      now: () => new Date('2026-07-12T00:02:00.000Z'),
    })
    const secondTimer = fakeTimer()
    createDurableWakeScheduler({
      registry: reloaded.registry,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      now: () => new Date('2026-07-12T00:02:00.000Z'),
      timer: secondTimer.port,
    })

    assert.equal(reloaded.recoverableAtStartup.length, 1)
    assert.deepEqual(secondTimer.delays, [480_000])
    assert.equal(reloaded.registry.get('wake-restart')?.status, 'running')
  })
})
