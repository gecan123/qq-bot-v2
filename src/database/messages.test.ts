import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from './client.js'
import { findMemoryEvidenceRows } from './messages.js'

const originalFindMany = prisma.message.findMany

afterEach(() => {
  ;(prisma.message as unknown as { findMany: typeof prisma.message.findMany }).findMany = originalFindMany
})

describe('memory evidence lookup', () => {
  test('returns claimant and scene metadata without binding evidence to the person subject', async () => {
    let captured: unknown
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<unknown[]> }).findMany = async (args) => {
      captured = args
      return [{
        id: 10,
        sceneKind: 'qq_group',
        sceneExternalId: '',
        groupId: 20001n,
        messageId: 900n,
        senderId: 99999n,
        sentAt: new Date('2026-07-01T00:00:00.000Z'),
        createdAt: new Date('2026-07-01T00:00:01.000Z'),
      }]
    }

    const result = await findMemoryEvidenceRows([10, 11])

    assert.deepEqual(result, [{
      rowId: 10,
      sceneKind: 'qq_group',
      sceneExternalId: '',
      groupId: 20001,
      messageId: '900',
      senderId: '99999',
      sentAt: '2026-07-01T08:00:00.000+08:00',
    }])
    assert.deepEqual(captured, {
      where: { id: { in: [10, 11] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        sceneKind: true,
        sceneExternalId: true,
        groupId: true,
        messageId: true,
        senderId: true,
        sentAt: true,
        createdAt: true,
      },
    })
  })

  test('does not query when no source rows are requested', async () => {
    ;(prisma.message as unknown as { findMany: () => Promise<unknown[]> }).findMany = async () => {
      assert.fail('findMany should not be called')
    }
    assert.deepEqual(await findMemoryEvidenceRows([]), [])
  })
})
