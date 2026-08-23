import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  acquireAgentCoreLock,
  AgentCoreAlreadyRunningError,
  type AgentCoreLockSession,
} from './agent-core-lock.js'

function fakeSession(acquired: boolean): { session: AgentCoreLockSession; events: string[] } {
  const events: string[] = []
  return {
    events,
    session: {
      async connect() { events.push('connect') },
      async query<T extends Record<string, unknown>>(text: string) {
        events.push(text.includes('try_advisory') ? 'try-lock' : 'unlock')
        return { rows: [{ acquired }] as unknown as T[] }
      },
      async end() { events.push('end') },
    },
  }
}

describe('Agent Core advisory lock', () => {
  test('holds a dedicated PostgreSQL session until release', async () => {
    const fake = fakeSession(true)
    const lock = await acquireAgentCoreLock({
      databaseUrl: 'postgresql://local/test',
      createSession: () => fake.session,
    })

    assert.deepEqual(fake.events, ['connect', 'try-lock'])
    await lock.release()
    await lock.release()
    assert.deepEqual(fake.events, ['connect', 'try-lock', 'unlock', 'end'])
  })

  test('fails closed and closes the session when another core owns the lock', async () => {
    const fake = fakeSession(false)
    await assert.rejects(
      acquireAgentCoreLock({
        databaseUrl: 'postgresql://local/test',
        createSession: () => fake.session,
      }),
      AgentCoreAlreadyRunningError,
    )
    assert.deepEqual(fake.events, ['connect', 'try-lock', 'end'])
  })
})
