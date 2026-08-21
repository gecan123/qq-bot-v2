import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deriveMemoryEvidence } from './memory-evidence.js'

describe('memory evidence identity', () => {
  test('keeps non-owner claimants and contexts platform scoped', () => {
    const result = deriveMemoryEvidence({
      rows: [{
        rowId: 10,
        platform: 'feishu',
        accountId: 'cli_1',
        conversationKind: 'group',
        conversationExternalId: 'oc_1',
        messageExternalId: 'om_1',
        senderExternalId: 'ou_1',
        sentAt: '2026-08-21T08:00:00.000+08:00',
      }],
      subjectKey: 'feishu:cli_1:ou_1',
    })

    assert.deepEqual(result, {
      context: {
        kind: 'conversation',
        conversation: {
          platform: 'feishu',
          accountId: 'cli_1',
          kind: 'group',
          externalId: 'oc_1',
        },
      },
      assertedByIds: ['feishu:cli_1:ou_1'],
      evidenceKind: 'self_report',
    })
  })

  test('binds only the configured owner across platforms into owner core', () => {
    const result = deriveMemoryEvidence({
      rows: [
        {
          rowId: 11,
          platform: 'qq',
          accountId: '10000',
          conversationKind: 'private',
          conversationExternalId: '20000',
          messageExternalId: '101',
          senderExternalId: '20000',
          sentAt: '2026-08-21T08:01:00.000+08:00',
        },
        {
          rowId: 12,
          platform: 'feishu',
          accountId: 'cli_1',
          conversationKind: 'private',
          conversationExternalId: 'oc_owner',
          messageExternalId: 'om_2',
          senderExternalId: 'ou_owner',
          sentAt: '2026-08-21T08:02:00.000+08:00',
        },
      ],
      subjectKey: 'owner',
      ownerIdentities: [
        { platform: 'qq', accountId: '10000', externalId: '20000' },
        { platform: 'feishu', accountId: 'cli_1', externalId: 'ou_owner' },
      ],
    })

    assert.deepEqual(result, {
      context: { kind: 'owner_core' },
      assertedByIds: ['owner'],
      evidenceKind: 'self_report',
    })
  })
})
