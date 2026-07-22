import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createYieldTool } from './yield.js'

describe('yield tool', () => {
  test('returns immediately and asks the runtime to stop the current round', async () => {
    const result = await createYieldTool().execute(
      { reason: '当前没有待处理行动' },
      { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 },
    )

    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      status: 'yielded',
      reason: '当前没有待处理行动',
    })
    assert.deepEqual(result.outcome, {
      ok: true,
      code: 'yielded',
      progress: false,
      continuation: 'stop',
    })
    assert.equal(result.effects, undefined)
  })

  test('uses a strict optional-only schema', () => {
    const schema = createYieldTool().schema
    assert.equal(schema.safeParse({}).success, true)
    assert.equal(schema.safeParse({ reason: '先交回控制权' }).success, true)
    assert.equal(schema.safeParse({ action: 'rest' }).success, false)
  })
})
