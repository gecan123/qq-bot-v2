import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { NCWebsocket } from 'node-napcat-ts'
import { resolveTargetMetadataMaps } from './resolve-target-meta.js'

type StubNapcat = Pick<NCWebsocket, 'get_group_info'>

function buildStub(overrides: Partial<{
  group: Record<number, { group_name?: string } | Error | 'timeout'>
}> = {}): StubNapcat {
  return {
    get_group_info: (async (params: { group_id: number }) => {
      const r = overrides.group?.[params.group_id]
      if (r === 'timeout') return new Promise(() => {})
      if (r instanceof Error) throw r
      return r ?? { group_name: '' }
    }) as unknown as NCWebsocket['get_group_info'],
  }
}

describe('resolveTargetMetadataMaps', () => {
  test('populates groupNames from successful get_group_info', async () => {
    const napcat = buildStub({ group: { 111: { group_name: '阳光厨房' }, 222: { group_name: '技术群' } } })
    const result = await resolveTargetMetadataMaps({
      napcat,
      groupIds: [111, 222],
      perCallTimeoutMs: 1000,
    })
    assert.deepEqual([...result.groupNames.entries()], [[111, '阳光厨房'], [222, '技术群']])
  })

  test('drops empty / blank group_name (so caller falls back to bare ID)', async () => {
    const napcat = buildStub({ group: { 111: { group_name: '   ' }, 222: { group_name: '技术群' } } })
    const result = await resolveTargetMetadataMaps({
      napcat,
      groupIds: [111, 222],
      perCallTimeoutMs: 1000,
    })
    assert.equal(result.groupNames.has(111), false)
    assert.equal(result.groupNames.get(222), '技术群')
  })

  test('per-entry failure does not block other entries (Promise.allSettled)', async () => {
    const napcat = buildStub({
      group: {
        111: new Error('boom'),
        222: { group_name: '技术群' },
      },
    })
    const result = await resolveTargetMetadataMaps({
      napcat,
      groupIds: [111, 222],
      perCallTimeoutMs: 1000,
    })
    assert.equal(result.groupNames.has(111), false)
    assert.equal(result.groupNames.get(222), '技术群')
  })

  test('per-entry timeout falls back to bare ID without blocking the rest', async () => {
    const napcat = buildStub({
      group: {
        111: 'timeout',
        222: { group_name: '技术群' },
      },
    })
    const start = Date.now()
    const result = await resolveTargetMetadataMaps({
      napcat,
      groupIds: [111, 222],
      perCallTimeoutMs: 50,
    })
    const elapsed = Date.now() - start
    assert.equal(result.groupNames.has(111), false)
    assert.equal(result.groupNames.get(222), '技术群')
    assert.ok(elapsed < 1000, `should not wait beyond per-call timeout, got ${elapsed}ms`)
  })

  test('handles empty input gracefully', async () => {
    const napcat = buildStub()
    const result = await resolveTargetMetadataMaps({
      napcat,
      groupIds: [],
      perCallTimeoutMs: 1000,
    })
    assert.equal(result.groupNames.size, 0)
  })
})
