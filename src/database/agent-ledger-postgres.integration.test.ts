import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from '../generated/prisma/client.js'
import { createAgentLedgerRepo, AgentLedgerHeadChangedError } from '../agent/agent-ledger-repo.js'
import { acquireAgentCoreLock, AgentCoreAlreadyRunningError } from './agent-core-lock.js'

const databaseUrl = process.env.QQ_BOT_TEST_DATABASE_URL

describe('real PostgreSQL ledger concurrency', { skip: databaseUrl == null }, () => {
  const first = databaseUrl ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) }) : null
  const second = databaseUrl ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) }) : null

  before(async () => {
    await first!.$connect()
    await second!.$connect()
    await first!.$transaction([
      first!.botAgentLedgerEntry.deleteMany(),
      first!.botAgentCheckpoint.deleteMany(),
      first!.botAgentRuntimeState.update({
        where: { id: 1 },
        data: {
          mailboxCursors: {}, inboxReadCursors: {},
          mailboxContinuity: { schemaVersion: 1, roundSeq: 0, lastInputTokens: null, compactionEpoch: 0, mailboxes: {} },
          goalRevision: 0, conversationFocus: Prisma.JsonNull, lastWakeAt: null, ledgerHeadEntryId: null,
        },
      }),
    ])
  })

  after(async () => {
    await Promise.all([first!.$disconnect(), second!.$disconnect()])
  })

  test('row locking plus expected-head CAS permits exactly one stale writer', async () => {
    const repos = [createAgentLedgerRepo({ client: first! as never }), createAgentLedgerRepo({ client: second! as never })]
    const results = await Promise.allSettled(repos.map((repo, index) => repo.appendMessages({
      expectedHeadEntryId: null,
      messages: [{ role: 'user', content: `writer-${index}` }],
    })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof AgentLedgerHeadChangedError)
    assert.equal(await first!.botAgentLedgerEntry.count(), 1)
  })

  test('dedicated advisory lock excludes a second Agent Core', async () => {
    const lock = await acquireAgentCoreLock({ databaseUrl: databaseUrl! })
    await assert.rejects(acquireAgentCoreLock({ databaseUrl: databaseUrl! }), AgentCoreAlreadyRunningError)
    await lock.release()
  })

  test('database constraints reject extra runtime and checkpoint singleton rows', async () => {
    await assert.rejects(first!.botAgentRuntimeState.create({
      data: {
        id: 2, schemaVersion: 1, mailboxCursors: {}, inboxReadCursors: {},
        mailboxContinuity: {}, goalRevision: 0, conversationFocus: Prisma.JsonNull,
      },
    }))
    await assert.rejects(first!.botAgentCheckpoint.create({
      data: { id: 2, schemaVersion: 1, throughEntryId: null, fingerprint: 'x', projection: {} },
    }))
  })
})
