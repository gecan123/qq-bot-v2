import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createApprovalManager, hashApprovalArgs, type ApprovalEvidence } from './approval-manager.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qq-bot-approval-'))
  tempDirs.push(dir)
  return join(dir, 'state', 'approvals.json')
}

function evidence(overrides: Partial<ApprovalEvidence> = {}): ApprovalEvidence {
  return {
    rowId: 42,
    sceneKind: 'qq_private',
    sceneExternalId: '12345',
    senderId: 12345n,
    text: '批准 apr-1',
    sentAt: new Date('2026-07-12T00:00:10.000Z'),
    ...overrides,
  }
}

describe('approval manager', () => {
  test('requires real owner private-message evidence and consumes approval exactly once', async () => {
    const path = statePath()
    let currentEvidence = evidence()
    let now = new Date('2026-07-12T00:00:00.000Z')
    let nextId = 0
    const manager = createApprovalManager({
      path,
      owner: { qq: 12345, name: 'owner' },
      now: () => now,
      idFactory: () => `apr-${++nextId}`,
      loadEvidence: async () => currentEvidence,
    })
    const args = { action: 'delete', files: ['self/a.md'] }

    const first = manager.authorize({ toolName: 'memory', args, reason: 'delete memory' })
    assert.equal(first.allowed, false)
    if (first.allowed) assert.fail('expected approval request')
    assert.equal(first.request?.id, 'apr-1')

    currentEvidence = evidence({ senderId: 999n })
    await assert.rejects(
      manager.approve({ approvalId: 'apr-1', messageRowId: 42 }),
      /configured owner/,
    )
    currentEvidence = evidence({ text: '批准别的东西' })
    await assert.rejects(
      manager.approve({ approvalId: 'apr-1', messageRowId: 42 }),
      /exactly equal/,
    )
    currentEvidence = evidence()
    now = new Date('2026-07-12T00:00:20.000Z')
    await manager.approve({ approvalId: 'apr-1', messageRowId: 42 })

    const consumed = manager.authorize({ toolName: 'memory', args, reason: 'delete memory' })
    assert.deepEqual(consumed, { allowed: true, approvalId: 'apr-1' })
    assert.equal(manager.get('apr-1')?.status, 'consumed')

    const next = manager.authorize({ toolName: 'memory', args, reason: 'delete memory' })
    assert.equal(next.allowed, false)
    if (!next.allowed) assert.equal(next.request?.id, 'apr-2')
  })

  test('persists an approved request across restart and still consumes it once', async () => {
    const path = statePath()
    const args = { action: 'publish', branch: 'main' }
    let now = new Date('2026-07-12T00:00:00.000Z')
    const common = {
      path,
      owner: { qq: 12345, name: 'owner' },
      now: () => now,
      loadEvidence: async () => evidence({ text: '批准 persisted' }),
    }
    const first = createApprovalManager({ ...common, idFactory: () => 'persisted' })
    first.authorize({ toolName: 'website', args, reason: 'publish' })
    now = new Date('2026-07-12T00:00:20.000Z')
    await first.approve({ approvalId: 'persisted', messageRowId: 42 })

    const reloaded = createApprovalManager(common)
    assert.deepEqual(
      reloaded.authorize({ toolName: 'website', args, reason: 'publish' }),
      { allowed: true, approvalId: 'persisted' },
    )
    assert.equal(reloaded.get('persisted')?.status, 'consumed')
  })

  test('expires pending requests and refuses approval after TTL', async () => {
    const path = statePath()
    let now = new Date('2026-07-12T00:00:00.000Z')
    const manager = createApprovalManager({
      path,
      owner: { qq: 12345, name: 'owner' },
      now: () => now,
      ttlMs: 1_000,
      idFactory: () => 'expires',
      loadEvidence: async () => evidence({ text: '批准 expires' }),
    })
    manager.authorize({ toolName: 'memory', args: { action: 'delete' }, reason: 'delete' })
    now = new Date('2026-07-12T00:00:02.000Z')

    await assert.rejects(
      manager.approve({ approvalId: 'expires', messageRowId: 42 }),
      /not pending: expired/,
    )
    assert.equal(manager.get('expires')?.status, 'expired')
  })

  test('rejects owner evidence sent after the request expiry even if local clock has not advanced there', async () => {
    const manager = createApprovalManager({
      path: statePath(),
      owner: { qq: 12345, name: 'owner' },
      now: () => new Date('2026-07-12T00:00:00.500Z'),
      ttlMs: 1_000,
      idFactory: () => 'late-evidence',
      loadEvidence: async () => evidence({
        text: '批准 late-evidence',
        sentAt: new Date('2026-07-12T00:00:02.000Z'),
      }),
    })
    manager.authorize({ toolName: 'memory', args: { action: 'delete' }, reason: 'delete' })
    await assert.rejects(
      manager.approve({ approvalId: 'late-evidence', messageRowId: 42 }),
      /after the approval request expired/,
    )
  })

  test('canonical args hash is independent of object key order', () => {
    assert.equal(
      hashApprovalArgs('tool', { b: 2, a: { y: 1, x: 0 } }),
      hashApprovalArgs('tool', { a: { x: 0, y: 1 }, b: 2 }),
    )
  })
})
