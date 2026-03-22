import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { getMessageTimestamp } from './message-time.js'

describe('getMessageTimestamp', () => {
  test('prefers sentAt when available', () => {
    const sentAt = new Date('2026-03-20T10:00:00.000Z')
    const createdAt = new Date('2026-03-20T12:00:00.000Z')

    const result = getMessageTimestamp({ sentAt, createdAt })

    assert.equal(result, sentAt)
  })

  test('falls back to createdAt when sentAt is null', () => {
    const createdAt = new Date('2026-03-20T12:00:00.000Z')

    const result = getMessageTimestamp({ sentAt: null, createdAt })

    assert.equal(result, createdAt)
  })
})
