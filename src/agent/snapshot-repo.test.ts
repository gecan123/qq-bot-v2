import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION, type PersistedAgentSnapshot } from './agent-context.types.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'
import { createBotSnapshotRepo, type BotSnapshotRepo } from './snapshot-repo.js'

interface SnapshotRow {
  id?: number | bigint
  schemaVersion: number
  contextSnapshot: unknown
  mailboxCursors: unknown
  mailboxContinuity: unknown
  goalRevision: number
  lastWakeAt: Date | null
  createdAt?: Date
}

interface FakeSnapshotClient {
  botAgentSnapshot: {
    findUnique(args: unknown): Promise<SnapshotRow | null>
    upsert(args: Record<string, unknown>): Promise<SnapshotRow>
  }
  botAgentSnapshotCheckpoint: {
    findMany(args: Record<string, unknown>): Promise<SnapshotRow[] | Array<{ id: bigint }>>
    create(args: Record<string, unknown>): Promise<SnapshotRow>
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
  $transaction<T>(task: (tx: FakeSnapshotClient) => Promise<T>): Promise<T>
}

function snapshot(label: string): PersistedAgentSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    activeToolCapabilities: [],
    qqConversationFocus: null,
    messages: [{ role: 'user', content: label }],
  }
}

function row(label: string): SnapshotRow {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    contextSnapshot: snapshot(label),
    mailboxCursors: { 'qq_private:1001': 3 },
    mailboxContinuity: {},
    goalRevision: 2,
    lastWakeAt: null,
  }
}

function corruptRow(label: string): SnapshotRow {
  return {
    ...row(label),
    contextSnapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      activeToolCapabilities: [],
      qqConversationFocus: null,
      messages: [{
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `missing-${label}`, name: 'lookup', args: {} }],
      }],
    },
  }
}

function makeFakeClient(current: SnapshotRow | null, initialCheckpoints: SnapshotRow[] = []): {
  client: FakeSnapshotClient
  state: { current: SnapshotRow | null; checkpoints: SnapshotRow[] }
} {
  const state = {
    current,
    checkpoints: initialCheckpoints.map((item, index) => ({
      ...item,
      id: BigInt(index + 1),
      createdAt: new Date(1_700_000_000_000 + index),
    })),
  }
  let nextId = state.checkpoints.length + 1
  const client: FakeSnapshotClient = {
    botAgentSnapshot: {
      async findUnique() {
        return state.current
      },
      async upsert(args) {
        const values = state.current
          ? args.update as SnapshotRow
          : args.create as SnapshotRow
        state.current = { ...values }
        return state.current
      },
    },
    botAgentSnapshotCheckpoint: {
      async findMany(args) {
        const ordered = [...state.checkpoints].sort((a, b) => {
          const timeDiff = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
          return timeDiff || Number((b.id as bigint) - (a.id as bigint))
        })
        const skip = typeof args.skip === 'number' ? args.skip : 0
        const selected = ordered.slice(skip)
        if (args.select) return selected.map((item) => ({ id: item.id as bigint }))
        return selected
      },
      async create(args) {
        const created = {
          ...(args.data as SnapshotRow),
          id: BigInt(nextId++),
          createdAt: new Date(1_700_000_000_000 + nextId),
        }
        state.checkpoints.push(created)
        return created
      },
      async deleteMany(args) {
        const ids = ((args.where as { id: { in: bigint[] } }).id.in)
        const before = state.checkpoints.length
        state.checkpoints = state.checkpoints.filter((item) => !ids.includes(item.id as bigint))
        return { count: before - state.checkpoints.length }
      },
    },
    async $transaction(task) {
      return task(client)
    },
  }
  return { client, state }
}

function repoWithClient(client: FakeSnapshotClient): BotSnapshotRepo {
  assert.equal(createBotSnapshotRepo.length, 1, 'snapshot repo factory must accept an injected client')
  const factory = createBotSnapshotRepo as unknown as (
    options: { client: FakeSnapshotClient },
  ) => BotSnapshotRepo
  return factory({ client })
}

describe('Bot snapshot repository integrity and checkpoints', () => {
  test('loads a valid current snapshot without using a checkpoint', async () => {
    const { client } = makeFakeClient(row('current'))
    const loaded = await repoWithClient(client).load()

    assert.equal(loaded?.snapshot.messages[0]?.role, 'user')
    assert.equal(loaded?.snapshot.messages[0]?.content, 'current')
    assert.equal(loaded?.recoveredFromCheckpoint, false)
  })

  test('recovers the newest valid checkpoint when the current snapshot is invalid', async () => {
    const { client } = makeFakeClient(corruptRow('current'), [row('older-valid')])
    const loaded = await repoWithClient(client).load()

    assert.equal(loaded?.snapshot.messages[0]?.role, 'user')
    assert.equal(loaded?.snapshot.messages[0]?.content, 'older-valid')
    assert.equal(loaded?.recoveredFromCheckpoint, true)
  })

  test('fails closed when both current snapshot and checkpoints are invalid', async () => {
    const { client } = makeFakeClient(corruptRow('current'), [corruptRow('checkpoint')])
    await assert.rejects(
      repoWithClient(client).load(),
      /snapshot integrity validation failed.*current.*checkpoint/s,
    )
  })

  test('checkpoints changed current snapshots and retains only the newest three', async () => {
    const { client, state } = makeFakeClient(row('v1'))
    const repo = repoWithClient(client)

    for (const label of ['v2', 'v3', 'v4', 'v5']) {
      await repo.save({
        snapshot: snapshot(label),
        mailboxCursors: { 'qq_private:1001': 3 },
        mailboxContinuity: createEmptyMailboxContinuityState(),
        goalRevision: 2,
        lastWakeAt: null,
      })
    }

    assert.equal(state.current?.contextSnapshot && (state.current.contextSnapshot as PersistedAgentSnapshot).messages[0]?.content, 'v5')
    assert.deepEqual(
      state.checkpoints.map((item) => (item.contextSnapshot as PersistedAgentSnapshot).messages[0]?.content),
      ['v2', 'v3', 'v4'],
    )
  })
})
