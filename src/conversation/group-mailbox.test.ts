import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createGroupMailbox } from './group-mailbox.js'
import { createConversationScheduler } from './scheduler.js'
import type { MentionEvent } from './types.js'

function makeEvent(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    groupId: overrides.groupId ?? 123,
    messageId: overrides.messageId ?? 1,
    senderId: overrides.senderId ?? 10,
    createdAt: overrides.createdAt ?? 0,
  }
}

describe('group mailbox', () => {
  test('same group mentions within 30s belong to one open window', () => {
    let closeWindow: (() => void) | undefined

    const mailbox = createGroupMailbox({
      groupId: 123,
      mergeWindowMs: 30_000,
      schedule: (callback) => {
        closeWindow = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: () => {},
    })

    mailbox.addMention(makeEvent({ messageId: 1, createdAt: 0 }))
    mailbox.addMention(makeEvent({ messageId: 2, senderId: 11, createdAt: 20_000 }))

    const snapshot = mailbox.snapshot()
    assert.equal(snapshot.pendingEvents.length, 2)
    assert.equal(snapshot.windowOpen, true)

    closeWindow?.()
    const afterClose = mailbox.snapshot()
    assert.equal(afterClose.readyBatches.length, 1)
    assert.equal(afterClose.windowOpen, false)
  })

  test('claimNextBatch marks group as running until finishCurrentRun', () => {
    let closeWindow: (() => void) | undefined

    const mailbox = createGroupMailbox({
      groupId: 123,
      mergeWindowMs: 30_000,
      schedule: (callback) => {
        closeWindow = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: () => {},
    })

    mailbox.addMention(makeEvent())
    closeWindow?.()

    const batch = mailbox.claimNextBatch()
    assert.ok(batch)
    assert.equal(mailbox.snapshot().running, true)
    assert.equal(mailbox.claimNextBatch(), undefined)

    mailbox.finishCurrentRun()
    assert.equal(mailbox.snapshot().running, false)
  })
})

describe('group mailbox proactive', () => {
  test('addMessage triggers debounce timer that flushes a proactive batch', () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = []

    const mailbox = createGroupMailbox({
      groupId: 1,
      mergeWindowMs: 20_000,
      proactiveDebounceMs: 90_000,
      proactiveMaxWaitMs: 300_000,
      schedule: (callback, delayMs) => {
        const entry = { callback, delayMs }
        timers.push(entry)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: () => {},
    })

    mailbox.addMessage()
    mailbox.addMessage()
    mailbox.addMessage()

    assert.equal(mailbox.snapshot().messagesSinceLastEval, 3)

    // debounce timer fires
    const debounceTimer = timers.find((t) => t.delayMs === 90_000)
    assert.ok(debounceTimer, 'debounce timer should be scheduled')
    debounceTimer.callback()

    const snap = mailbox.snapshot()
    assert.equal(snap.readyBatches.length, 1)
    assert.equal(snap.readyBatches[0]?.messagesSinceLastEval, 3)
    assert.equal(snap.readyBatches[0]?.events.length, 0)
    assert.equal(snap.messagesSinceLastEval, 0)
  })

  test('maxWait timer forces flush even when debounce keeps resetting', () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    let cleared: number[] = []

    const mailbox = createGroupMailbox({
      groupId: 1,
      mergeWindowMs: 20_000,
      proactiveDebounceMs: 90_000,
      proactiveMaxWaitMs: 300_000,
      schedule: (callback, delayMs) => {
        const entry = { callback, delayMs }
        timers.push(entry)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: (timer) => {
        cleared.push(timer as unknown as number)
      },
    })

    // 模拟持续热聊
    for (let i = 0; i < 20; i++) {
      mailbox.addMessage()
    }

    assert.equal(mailbox.snapshot().messagesSinceLastEval, 20)

    // maxWait timer fires (300s)
    const maxWaitTimer = timers.find((t) => t.delayMs === 300_000)
    assert.ok(maxWaitTimer, 'maxWait timer should be scheduled')
    maxWaitTimer.callback()

    const snap = mailbox.snapshot()
    assert.equal(snap.readyBatches.length, 1)
    assert.equal(snap.readyBatches[0]?.messagesSinceLastEval, 20)
    assert.equal(snap.messagesSinceLastEval, 0)
  })

  test('addMessage does nothing when proactiveDebounceMs is not set', () => {
    const mailbox = createGroupMailbox({
      groupId: 1,
      mergeWindowMs: 20_000,
    })

    mailbox.addMessage()
    mailbox.addMessage()

    assert.equal(mailbox.snapshot().messagesSinceLastEval, 0)
    assert.equal(mailbox.snapshot().readyBatches.length, 0)
  })

  test('stop clears proactive timers and resets state', () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = []

    const mailbox = createGroupMailbox({
      groupId: 1,
      mergeWindowMs: 20_000,
      proactiveDebounceMs: 90_000,
      schedule: (callback, delayMs) => {
        timers.push({ callback, delayMs })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: () => {},
    })

    mailbox.addMessage()
    mailbox.addMessage()
    mailbox.stop()

    assert.equal(mailbox.snapshot().messagesSinceLastEval, 0)
    assert.equal(mailbox.snapshot().readyBatches.length, 0)
  })
})

describe('conversation scheduler', () => {
  test('same group never runs two workers concurrently', async () => {
    const callbacks: Array<() => void> = []
    const runs: string[] = []

    const scheduler = createConversationScheduler({
      mergeWindowMs: 5,
      worker: async (batch) => {
        runs.push(`start:${batch.events[0]?.messageId}`)
        await new Promise<void>((resolve) => callbacks.push(resolve))
        runs.push(`end:${batch.events[0]?.messageId}`)
      },
    })
    try {
      scheduler.onMention(makeEvent({ groupId: 1, messageId: 1, createdAt: Date.now() }))
      await new Promise((resolve) => setTimeout(resolve, 15))
      scheduler.onMention(makeEvent({ groupId: 1, messageId: 2, createdAt: Date.now() }))
      await new Promise((resolve) => setTimeout(resolve, 15))

      assert.deepEqual(runs, ['start:1'])

      callbacks.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(runs, ['start:1', 'end:1', 'start:2'])

      callbacks.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(runs, ['start:1', 'end:1', 'start:2', 'end:2'])
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.()
      }
      scheduler.stop()
    }
  })

  test('different groups may run in parallel', async () => {
    const started: number[] = []
    const callbacks = new Map<number, () => void>()

    const scheduler = createConversationScheduler({
      mergeWindowMs: 5,
      worker: async (batch) => {
        started.push(batch.groupId)
        await new Promise<void>((resolve) => callbacks.set(batch.groupId, resolve))
      },
    })
    try {
      scheduler.onMention(makeEvent({ groupId: 1, messageId: 1, createdAt: Date.now() }))
      scheduler.onMention(makeEvent({ groupId: 2, messageId: 2, createdAt: Date.now() }))

      await new Promise((resolve) => setTimeout(resolve, 15))

      assert.equal(started.includes(1), true)
      assert.equal(started.includes(2), true)
    } finally {
      callbacks.get(1)?.()
      callbacks.get(2)?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      scheduler.stop()
    }
  })

  test('same group leftover events continue in the next run after current batch completes', async () => {
    const callbacks: Array<() => void> = []
    const runs: number[] = []

    const scheduler = createConversationScheduler({
      mergeWindowMs: 5,
      worker: async (batch) => {
        runs.push(batch.events[0]?.messageId ?? -1)

        await new Promise<void>((resolve) => callbacks.push(resolve))

        if (batch.events[0]?.messageId === 1) {
          return {
            leftoverEvents: [makeEvent({ groupId: 1, messageId: 99, senderId: 30, createdAt: Date.now() })],
          }
        }
      },
    })

    try {
      scheduler.onMention(makeEvent({ groupId: 1, messageId: 1, createdAt: Date.now() }))
      await new Promise((resolve) => setTimeout(resolve, 15))
      assert.deepEqual(runs, [1])

      callbacks.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 15))
      assert.deepEqual(runs, [1, 99])

      callbacks.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.()
      }
      scheduler.stop()
    }
  })
})
