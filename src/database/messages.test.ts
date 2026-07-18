import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from './client.js'
import { findValidMemoryEvidenceRowIds } from './messages.js'

const originalFindMany = prisma.message.findMany

afterEach(() => {
  ;(prisma.message as unknown as { findMany: typeof prisma.message.findMany }).findMany = originalFindMany
})

describe('memory evidence lookup', () => {
  test('binds person evidence to the target senderId', async () => {
    let captured: unknown
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<Array<{ id: number }>> }).findMany = async (args) => {
      captured = args
      return [{ id: 10 }]
    }

    const result = await findValidMemoryEvidenceRowIds({
      sourceMessageIds: [10, 11],
      scope: 'person',
      id: '10001',
    })

    assert.deepEqual(result, [10])
    assert.deepEqual(captured, {
      where: { id: { in: [10, 11] }, senderId: 10001n },
      select: { id: true },
    })
  })

  test('binds group evidence to a QQ group row and rejects non-numeric entity ids', async () => {
    let calls = 0
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<Array<{ id: number }>> }).findMany = async (args) => {
      calls++
      assert.deepEqual(args, {
        where: { id: { in: [20] }, sceneKind: 'qq_group', groupId: 20001n },
        select: { id: true },
      })
      return [{ id: 20 }]
    }

    assert.deepEqual(await findValidMemoryEvidenceRowIds({
      sourceMessageIds: [20],
      scope: 'group',
      id: '20001',
    }), [20])
    assert.deepEqual(await findValidMemoryEvidenceRowIds({
      sourceMessageIds: [20],
      scope: 'group',
      id: 'not-a-group-id',
    }), [])
    assert.equal(calls, 1)
  })
})
