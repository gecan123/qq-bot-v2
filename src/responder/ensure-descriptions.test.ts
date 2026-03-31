import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectReferenceIds } from './ensure-descriptions.js'
import type { ParsedSegment } from '../types/message-segments.js'

describe('collectReferenceIds', () => {
  test('returns referenceIds from image, video, record, and file segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'image', referenceId: '42' },
        { type: 'text', content: 'hello' },
        { type: 'video', referenceId: '99' },
      ],
      [{ type: 'record', referenceId: '7' }],
      [{ type: 'file', referenceId: '3' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [42, 99, 7, 3])
  })

  test('ignores segments without referenceId', () => {
    const groups: ParsedSegment[][] = [
      [{ type: 'image', url: 'http://example.com/img.jpg' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('ignores non-media segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'text', content: 'hello' },
        { type: 'face', faceId: 1 },
        { type: 'at', targetId: '123' },
      ],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(collectReferenceIds([]), [])
  })

  test('returns empty array for messages with no segments', () => {
    assert.deepEqual(collectReferenceIds([[]]), [])
  })

  test('ignores invalid referenceIds', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'image', referenceId: 'abc' },
        { type: 'video', referenceId: '-1' },
        { type: 'record', referenceId: '0' },
        { type: 'file', referenceId: '12' },
      ],
    ]
    assert.deepEqual(collectReferenceIds(groups), [12])
  })
})
