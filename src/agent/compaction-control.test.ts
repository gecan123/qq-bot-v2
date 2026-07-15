import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import {
  MAX_MANUAL_COMPACTION_FOCUS_CHARS,
  createStartupCompactionControlGate,
  parseCompactionControlCommand,
  replayOwnerCompactionCommands,
} from './compaction-control.js'

describe('owner compaction control', () => {
  test('parses /compact and keeps only the bounded trailing focus', () => {
    assert.deepEqual(parseCompactionControlCommand('/compact'), {})
    assert.deepEqual(parseCompactionControlCommand('/compact 关注工具结果'), {
      focus: '关注工具结果',
    })
    assert.equal(parseCompactionControlCommand('请执行 /compact'), null)
    assert.throws(
      () => parseCompactionControlCommand(`/compact ${'x'.repeat(MAX_MANUAL_COMPACTION_FOCUS_CHARS + 1)}`),
      /focus.*最多/,
    )
  })

  test('accepts only a real owner friend-private envelope', async () => {
    const gate = createStartupCompactionControlGate({ owner: { qq: 100, name: 'owner' } })
    const base = {
      peerId: 100,
      senderId: 100,
      messageRowId: 1,
      renderedText: '/compact',
    }

    assert.equal((await gate.submit({ ...base, scene: 'group' })).handled, false)
    assert.equal((await gate.submit({ ...base, scene: 'other_private' })).handled, false)
    assert.equal((await gate.submit({ ...base, peerId: 200, scene: 'friend_private' })).handled, false)
    assert.equal((await gate.submit({ ...base, senderId: 200, scene: 'friend_private' })).handled, false)
    assert.equal((await gate.submit({ ...base, renderedText: '转述: /compact', scene: 'friend_private' })).handled, false)
    assert.equal((await gate.submit({ ...base, scene: 'friend_private' })).handled, true)
  })

  test('replay and live overlap execute once in row order after runtime becomes ready', async () => {
    const originalFindMany = prisma.message.findMany
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<unknown[]> }).findMany = async () => [
      {
        id: 11,
        senderId: 100n,
        sceneExternalId: '100',
        searchText: '/compact 先保留状态',
        resolvedText: '/compact 先保留状态',
      },
      {
        id: 12,
        senderId: 100n,
        sceneExternalId: '100',
        searchText: '/compact 后来的 live',
        resolvedText: '/compact 后来的 live',
      },
    ]
    try {
      const gate = createStartupCompactionControlGate({ owner: { qq: 100, name: 'owner' } })
      const calls: Array<string | undefined> = []
      const live = await gate.submit({
        scene: 'friend_private',
        peerId: 100,
        senderId: 100,
        messageRowId: 12,
        renderedText: '/compact 后来的 live',
      })
      assert.equal(live.handled, true)
      assert.equal(calls.length, 0)

      const replayed = await replayOwnerCompactionCommands({
        owner: { qq: 100, name: 'owner' },
        mailboxCursors: { 'qq_private:100': 10 },
        legacyLastWakeAt: null,
        submit: (event) => gate.submit(event),
      })
      assert.deepEqual(replayed, { matched: 2, handled: 2 })
      await gate.finishReplay()
      assert.equal(calls.length, 0)

      await gate.setRuntime(async (focus) => {
        calls.push(focus)
        return true
      })
      assert.deepEqual(calls, ['先保留状态', '后来的 live'])

      const duplicate = await gate.submit({
        scene: 'friend_private',
        peerId: 100,
        senderId: 100,
        messageRowId: 12,
        renderedText: '/compact 后来的 live',
      })
      assert.equal(duplicate.handled, true)
      assert.equal(duplicate.duplicate, true)
      assert.deepEqual(calls, ['先保留状态', '后来的 live'])
    } finally {
      ;(prisma.message as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany
    }
  })

  test('a handled control can be suppressed instead of entering ordinary LLM history', async () => {
    const gate = createStartupCompactionControlGate({ owner: { qq: 100, name: 'owner' } })
    const ordinaryHistory: string[] = []
    const event = {
      scene: 'friend_private' as const,
      peerId: 100,
      senderId: 100,
      messageRowId: 20,
      renderedText: '/compact',
    }

    const result = await gate.submit(event)
    if (!result.handled) ordinaryHistory.push(event.renderedText)

    assert.deepEqual(ordinaryHistory, [])
  })
})
