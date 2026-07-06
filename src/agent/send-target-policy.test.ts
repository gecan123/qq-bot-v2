import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSendTargetPolicy } from './send-target-policy.js'

describe('send target policy', () => {
  test('allows replies only to monitored groups', async () => {
    const policy = createSendTargetPolicy({
      groupIds: [111],
      groupAmbientSendIds: new Set([111]),
      loadFriendIds: async () => [],
    })

    assert.deepEqual(
      await policy.authorize({ target: { type: 'group', groupId: 111 }, mode: 'reply' }),
      { allowed: true },
    )
    assert.deepEqual(
      await policy.authorize({ target: { type: 'group', groupId: 222 }, mode: 'reply' }),
      { allowed: false, error: 'groupId=222 is not monitored' },
    )
  })

  test('allows ambient sends only to monitored ambient-enabled groups', async () => {
    const policy = createSendTargetPolicy({
      groupIds: [111, 222],
      groupAmbientSendIds: new Set([111]),
      loadFriendIds: async () => [],
    })

    assert.deepEqual(
      await policy.authorize({ target: { type: 'group', groupId: 111 }, mode: 'ambient' }),
      { allowed: true },
    )
    assert.deepEqual(
      await policy.authorize({ target: { type: 'group', groupId: 222 }, mode: 'ambient' }),
      { allowed: false, error: 'groupId=222 does not allow ambient sends' },
    )
  })

  test('checks the current NapCat friend list for every private send', async () => {
    let calls = 0
    const policy = createSendTargetPolicy({
      groupIds: [],
      groupAmbientSendIds: new Set(),
      loadFriendIds: async () => {
        calls++
        return calls === 1 ? [9001] : [9002]
      },
    })

    assert.deepEqual(
      await policy.authorize({ target: { type: 'private', userId: 9001 }, mode: 'ambient' }),
      { allowed: true },
    )
    assert.deepEqual(
      await policy.authorize({ target: { type: 'private', userId: 9001 }, mode: 'reply' }),
      { allowed: false, error: 'userId=9001 is not a current QQ friend' },
    )
    assert.equal(calls, 2)
  })

  test('fails closed when the friend list cannot be loaded', async () => {
    const policy = createSendTargetPolicy({
      groupIds: [],
      groupAmbientSendIds: new Set(),
      loadFriendIds: async () => {
        throw new Error('NapCat offline')
      },
    })

    assert.deepEqual(
      await policy.authorize({ target: { type: 'private', userId: 9001 }, mode: 'ambient' }),
      { allowed: false, error: 'QQ friend list unavailable: NapCat offline' },
    )
  })
})
