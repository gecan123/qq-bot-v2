import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createClockTool } from './clock.js'

describe('clock tool', () => {
  test('returns one minute-level current-time baseline without runtime duration', async () => {
    const clock = createClockTool({
      now: () => new Date('2026-08-28T03:47:59.999Z'),
    })

    const result = await clock.execute({}, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })

    assert.deepEqual(JSON.parse(result.content as string), {
      now: '2026-08-28T11:47+08:00',
    })
    assert.deepEqual(result.outcome, {
      ok: true,
      code: 'time_observed',
      progress: false,
    })
  })
})
