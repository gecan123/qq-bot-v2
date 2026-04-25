import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { recoverConversationStartupState } from './recovery.js'
import type { ActionDeliveryState, ActionRecord } from '../runtime/agent-runtime-types.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), 'utf8')
const projectFileExists = (relativePath: string): boolean => existsSync(resolve(projectRoot, relativePath))
const assertIncludes = (content: string, needle: string, message?: string): void => {
  assert.ok(content.includes(needle), message ?? `expected file to include ${needle}`)
}
const assertExcludes = (content: string, needle: string, message?: string): void => {
  assert.ok(!content.includes(needle), message ?? `expected file not to include ${needle}`)
}

describe('Phase 0 recovery contract', () => {
  test('startup recovery is based on action_records and never reply_records', () => {
    const recovery = readProjectFile('src/conversation/recovery.ts')

    for (const expected of ['actionRecord', 'ActionRecord', 'deliveryState']) {
      assertIncludes(recovery, expected)
    }
    for (const forbidden of ['replyRecord', 'ReplyRecord', 'reply_records']) {
      assertExcludes(recovery, forbidden, `recovery must not depend on reply-only ledger: ${forbidden}`)
    }
  })

  test('recovery covers retryable delivery states', () => {
    const recovery = readProjectFile('src/conversation/recovery.ts')
    for (const state of ['pending', 'sending', 'failed', 'acked']) {
      assertIncludes(recovery, state, `recovery must make ${state} action_records explicit`)
    }
  })

  test('startup recovery sends new action payload reply records through replyToMessage', async () => {
    const actionRecord: ActionRecord = {
      id: 'record-1',
      actionIntentId: 'intent-1',
      actionType: 'send_group_reply',
      targetSceneId: 'qq_group:1',
      deliveryState: 'pending',
      idempotencyKey: 'intent-1:record',
      resultPayload: {
        sourceRefs: {
          incorporatedMessageRowId: 2,
          source: 'messages',
        },
        target: {
          sceneId: 'qq_group:1',
          groupId: 1,
        },
        deliveryPayload: {
          type: 'reply_to_message',
          replyToMessageId: 1001,
          mentionUserId: 20,
        },
        proposedEffect: {
          type: 'reply_to_message',
          text: '恢复回复',
        },
      },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
    const states: ActionDeliveryState[] = []

    const result = await recoverConversationStartupState({
      groupIds: [1],
      sender: {
        replyToMessage: async (params) => {
          assert.equal(params.groupId, 1)
          assert.equal(params.replyToMessageId, 1001)
          assert.equal(params.mentionUserId, 20)
          assert.equal(params.text, '恢复回复')
          return { success: true, attempts: 1, providerMessageId: 1002 }
        },
        sendMessage: async () => {
          throw new Error('sendMessage should not recover send_group_reply records')
        },
      },
      actionRecordStore: {
        listRecoverable: async (sceneIds) => {
          assert.deepEqual(sceneIds, ['qq_group:1'])
          return [actionRecord]
        },
        markDeliveryState: async (id, state, resultPayload) => {
          assert.equal(id, 'record-1')
          states.push(state)
          if (state === 'sent') {
            assert.equal(resultPayload?.providerMessageId, 1002)
            assert.equal(resultPayload?.attempts, 1)
          }
        },
      },
    })

    assert.equal(result.recoveredActionRecords, 1)
    assert.equal(result.failedActionRecords, 0)
    assert.deepEqual(states, ['sending', 'sent'])
  })
})
