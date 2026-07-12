import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createGroupMuteInspector } from './group-mute-inspector.js'

describe('group mute inspector', () => {
  test('matches the bot qid and converts shutUpTime seconds to ISO', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList(groupId) {
        assert.equal(groupId, 456)
        return [
          { qid: '999', shutUpTime: 1_800_000_000 },
          { qid: '123', shutUpTime: 1_700_000_000 },
        ]
      },
    })

    assert.deepEqual(await inspector.inspect(456), {
      muted: true,
      mutedUntil: '2023-11-15T06:13:20.000+08:00',
    })
  })

  test('returns muted=false when the bot is absent', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList() {
        return [{ qid: '999', shutUpTime: 1_700_000_000 }]
      },
    })

    assert.deepEqual(await inspector.inspect(456), { muted: false })
  })

  test('keeps confirmed mute but omits an invalid timestamp', async () => {
    const inspector = createGroupMuteInspector({
      selfNumber: 123,
      async loadGroupShutList() {
        return [{ qid: '123', shutUpTime: Number.NaN }]
      },
    })

    assert.deepEqual(await inspector.inspect(456), { muted: true })
  })
})
