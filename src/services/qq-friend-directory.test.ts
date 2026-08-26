import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadQqFriendsSafely } from './qq-friend-directory.js'

test('QQ friend directory timeout degrades to the configured owner', async () => {
  const result = await loadQqFriendsSafely({
    loadFriends: () => new Promise(() => undefined),
    owner: { qq: 10001, name: 'Owner' },
    timeoutMs: 10,
  })

  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.friends, [{ userId: 10001, nickname: 'Owner' }])
  assert.match(String(result.error), /timed out after 10ms/)
})

test('QQ friend directory keeps live friends and adds the owner once', async () => {
  const result = await loadQqFriendsSafely({
    async loadFriends() {
      return [
        { userId: 10001, nickname: 'Current Owner', remark: 'Owner Remark' },
        { userId: 10002, nickname: 'Friend' },
      ]
    },
    owner: { qq: 10001, name: 'Configured Owner' },
    timeoutMs: 100,
  })

  assert.equal(result.status, 'live')
  assert.deepEqual(result.friends, [
    { userId: 10001, nickname: 'Current Owner', remark: 'Owner Remark' },
    { userId: 10002, nickname: 'Friend' },
  ])
})
