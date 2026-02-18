import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { withInFlight } from './in-flight.js'

describe('withInFlight', () => {
  test('calls fn once when two concurrent calls share the same key', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const slow = () =>
      new Promise<void>((resolve) => {
        callCount++
        setTimeout(resolve, 10)
      })

    await Promise.all([withInFlight(cache, 1, slow), withInFlight(cache, 1, slow)])

    assert.equal(callCount, 1)
  })

  test('calls fn again after the first call completes', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const fn = () =>
      new Promise<void>((resolve) => {
        callCount++
        resolve()
      })

    await withInFlight(cache, 1, fn)
    await withInFlight(cache, 1, fn)

    assert.equal(callCount, 2)
  })

  test('different keys run independently', async () => {
    const cache = new Map<number, Promise<void>>()
    let callCount = 0
    const slow = () =>
      new Promise<void>((resolve) => {
        callCount++
        setTimeout(resolve, 10)
      })

    await Promise.all([withInFlight(cache, 1, slow), withInFlight(cache, 2, slow)])

    assert.equal(callCount, 2)
  })

  test('clears key from cache after fn completes', async () => {
    const cache = new Map<number, Promise<void>>()
    const fn = () => Promise.resolve()

    await withInFlight(cache, 1, fn)

    assert.equal(cache.size, 0)
  })
})
