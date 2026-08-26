import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createDedupEnqueue } from './dedup-enqueue.js'

function makeGroupEvent(rowId: number): BotEvent {
  return {
    type: 'chat_message',
    eventKind: 'message',
    messageRowId: rowId,
    conversation: { platform: 'qq', accountId: '999', kind: 'group', externalId: '111' },
    messageExternalId: String(1000 + rowId),
    senderExternalId: '100',
    senderName: 'a',
    mentionedSelf: false,
    sentAt: new Date('2026-05-04T00:00:00Z'),
    renderedText: 't',
  }
}

describe('createDedupEnqueue — replay × live overlap by messageRowId', () => {
  test('dedupes message events by global messageRowId during replay overlap', () => {
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

  test('different rowIds are not deduped', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makeGroupEvent(1))
    enq(makeGroupEvent(2))
    enq(makeGroupEvent(3))

    assert.equal(q.size(), 3)
  })

  test('control events (wake) are not deduped because they have no messageRowId', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq({ type: 'wake' })
    enq({ type: 'wake' })
    enq({ type: 'wake' })

    assert.equal(q.size(), 3, 'wake events should always pass through')
  })

  test('finishReplay releases seen row IDs and disables steady-state tracking', () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    enq(makeGroupEvent(1))
    enq(makeGroupEvent(2))

    enq.finishReplay()
    enq.finishReplay()

    assert.equal(enq(makeGroupEvent(1)), true)
    assert.equal(enq(makeGroupEvent(1)), true)
    assert.equal(q.size(), 4)
  })
})
