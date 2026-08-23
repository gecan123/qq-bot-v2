import { Client } from 'pg'

const LOCK_NAMESPACE = 0x7162
const LOCK_ID = 0x7632

export interface AgentCoreLock {
  release(): Promise<void>
}

export interface AgentCoreLockSession {
  connect(): Promise<void>
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>
  end(): Promise<void>
}

export class AgentCoreAlreadyRunningError extends Error {
  constructor() {
    super('another Agent Core already owns the PostgreSQL advisory lock')
    this.name = 'AgentCoreAlreadyRunningError'
  }
}

export async function acquireAgentCoreLock(input: {
  databaseUrl: string
  createSession?: (databaseUrl: string) => AgentCoreLockSession
}): Promise<AgentCoreLock> {
  const session = input.createSession?.(input.databaseUrl)
    ?? new Client({ connectionString: input.databaseUrl }) as AgentCoreLockSession
  let connected = false
  try {
    await session.connect()
    connected = true
    const result = await session.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
      [LOCK_NAMESPACE, LOCK_ID],
    )
    if (result.rows[0]?.acquired !== true) throw new AgentCoreAlreadyRunningError()
  } catch (error) {
    if (connected) await session.end().catch(() => undefined)
    throw error
  }

  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        await session.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer) AS released',
          [LOCK_NAMESPACE, LOCK_ID],
        )
      } finally {
        await session.end()
      }
    },
  }
}
