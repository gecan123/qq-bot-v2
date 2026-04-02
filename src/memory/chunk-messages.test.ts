import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { chunkByTimeGap, addOverlap } from './chunk-messages.js'

function makeMsg(minutesFromStart: number, id = 1) {
  return {
    messageId: BigInt(id),
    sentAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutesFromStart, 0)),
  }
}

describe('chunkByTimeGap', () => {
  test('keeps all messages in one chunk when no large gap', () => {
    const msgs = [makeMsg(0, 1), makeMsg(5, 2), makeMsg(10, 3)]
    const chunks = chunkByTimeGap(msgs as never, 20)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].length, 3)
  })

  test('splits on gap exceeding threshold', () => {
    const msgs = [makeMsg(0, 1), makeMsg(5, 2), makeMsg(30, 3), makeMsg(35, 4)]
    const chunks = chunkByTimeGap(msgs as never, 20)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].length, 2)
    assert.equal(chunks[1].length, 2)
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(chunkByTimeGap([], 20), [])
  })

  test('prefers sentAt over createdAt when computing gaps', () => {
    const msgs = [
      {
        messageId: 1n,
        sentAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)),
      },
      {
        messageId: 2n,
        sentAt: new Date(Date.UTC(2026, 0, 1, 0, 5, 0)),
        createdAt: new Date(Date.UTC(2026, 0, 1, 1, 5, 0)),
      },
      {
        messageId: 3n,
        sentAt: new Date(Date.UTC(2026, 0, 1, 0, 40, 0)),
        createdAt: new Date(Date.UTC(2026, 0, 1, 1, 6, 0)),
      },
    ]
    const chunks = chunkByTimeGap(msgs as never, 20)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].length, 2)
    assert.equal(chunks[1].length, 1)
  })
})

describe('addOverlap', () => {
  test('first chunk is unchanged', () => {
    const chunks = [[makeMsg(0, 1), makeMsg(1, 2)], [makeMsg(30, 3)]] as never
    const result = addOverlap(chunks, 2)
    assert.equal(result[0].length, 2)
  })

  test('subsequent chunks prepend tail of previous chunk', () => {
    const a = [makeMsg(0, 1), makeMsg(1, 2), makeMsg(2, 3)]
    const b = [makeMsg(30, 4)]
    const result = addOverlap([a, b] as never, 2)
    assert.equal(result[1].length, 3) // 2 overlap + 1 original
    assert.equal(result[1][0].messageId, 2n)
    assert.equal(result[1][2].messageId, 4n)
  })
})
