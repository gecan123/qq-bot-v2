import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createDedupEnqueue } from './dedup-enqueue.js'

function makeGroupEvent(rowId: number): BotEvent {
  return {
    type: 'napcat_message',
    messageRowId: rowId,
    groupId: 111,
    messageId: 1000 + rowId,
    senderId: 100,
    senderNickname: 'a',
    mentionedSelf: false,
    sentAt: new Date('2026-05-04T00:00:00Z'),
    renderedText: 't',
  }
}

function makePrivateEvent(rowId: number): BotEvent {
  return {
    type: 'napcat_private_message',
    messageRowId: rowId,
    peerId: 10001,
    messageId: 2000 + rowId,
    senderId: 10001,
    senderNickname: 'p',
    mentionedSelf: true,
    sentAt: new Date('2026-05-04T00:00:00Z'),
    renderedText: 'pt',
  }
}

describe('createDedupEnqueue — replay × live overlap by messageRowId', () => {
  test('dedupes group events by messageRowId (CRITICAL: live ingest then replay sees same row)', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    // Sequence: live event arrives first (NapCat fired right after connect), then replay
    // findMany picks up the same row from DB.
    const liveAccepted = enq(makeGroupEvent(42))
    const replayAccepted = enq(makeGroupEvent(42))

    assert.equal(liveAccepted, true, 'live event should be accepted')
    assert.equal(replayAccepted, false, 'replay must skip already-seen rowId')
    assert.equal(q.size(), 1, 'only one event in the queue')
  })

  test('dedupes private events by messageRowId', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makePrivateEvent(7))
    const second = enq(makePrivateEvent(7))

    assert.equal(second, false)
    assert.equal(q.size(), 1)
  })

  test('different rowIds are not deduped', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makeGroupEvent(1))
    enq(makeGroupEvent(2))
    enq(makeGroupEvent(3))

    assert.equal(q.size(), 3)
  })

  test('group rowId 7 and private rowId 7 are different events (rowId is global, but if collision happens, dedup is still correct since rowId IS the PK)', () => {
    // The Message PK `id` is globally unique across qq_group / qq_private. So if we
    // ever see rowId=7 twice, they are the same row regardless of scene. Dedup is correct.
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makeGroupEvent(7))
    const collision = enq(makePrivateEvent(7))

    assert.equal(collision, false, 'same rowId across scenes should still dedup (Message.id is global PK)')
    assert.equal(q.size(), 1)
  })

  test('control events (wake) are not deduped because they have no messageRowId', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq({ type: 'wake' })
    enq({ type: 'wake' })
    enq({ type: 'wake' })

    assert.equal(q.size(), 3, 'wake events should always pass through')
  })

  test('seenCount reports unique messageRowIds enqueued', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makeGroupEvent(1))
    enq(makeGroupEvent(2))
    enq(makeGroupEvent(2)) // dup
    enq(makePrivateEvent(3))
    enq({ type: 'wake' }) // wake doesn't count

    assert.equal(enq.seenCount(), 3)
  })
})
