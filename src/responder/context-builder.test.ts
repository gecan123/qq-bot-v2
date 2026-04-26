import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { buildContext } from './context-builder.js'
import type { IncomingMessage } from './pipeline.js'
import type { Message } from '../generated/prisma/client.js'
import type { ActionRecord } from '../runtime/agent-runtime-types.js'

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

describe('Phase 0 responder context contract', () => {
  test('context is rebuilt from messages plus sent action_records', () => {
    const contextBuilder = readProjectFile('src/responder/context-builder.ts')

    assertIncludes(contextBuilder, 'message', 'messages remain the only inbound user-fact ledger')
    for (const expected of ['actionRecord', 'ActionRecord', 'deliveryState', 'sent']) {
      assertIncludes(contextBuilder, expected)
    }
    for (const forbidden of ['replyRecord', 'ReplyRecord', 'reply_records']) {
      assertExcludes(contextBuilder, forbidden, `context builder must not read reply-only ledger: ${forbidden}`)
    }
  })

  test('context builder does not read dormant memory items', () => {
    const contextBuilder = readProjectFile('src/responder/context-builder.ts')
    assertExcludes(contextBuilder, 'MemoryItem')
    assertExcludes(contextBuilder, 'memoryItems')
  })

  test('context reads proposedEffect text from runtime action records', async () => {
    const message: Message = {
      id: 1,
      sceneKind: 'qq_group',
      sceneExternalId: '1',
      groupId: BigInt(1),
      groupName: '测试群',
      mediaReferenceIds: [],
      messageId: BigInt(1001),
      senderId: BigInt(20),
      senderNickname: '用户20',
      senderGroupNickname: null,
      content: [{ type: 'text', content: '你好' }] as Message['content'],
      rawContent: null,
      rawMessage: null,
      searchText: '你好',
      resolvedText: '你好',
      sentAt: new Date('2026-04-21T00:00:00Z'),
      createdAt: new Date('2026-04-21T00:00:00Z'),
    }
    const actionRecord: ActionRecord = {
      id: 'action-1',
      actionIntentId: 'intent-1',
      actionType: 'send_group_reply',
      targetSceneId: 'qq_group:1',
      deliveryState: 'sent',
      idempotencyKey: 'intent-1',
      resultPayload: {
        sourceRefs: {
          triggerMessageRowId: 1,
          incorporatedMessageRowId: 1,
          source: 'messages',
        },
        proposedEffect: {
          type: 'reply_to_message',
          text: '机器人回复',
        },
      },
      createdAt: new Date('2026-04-21T00:00:30Z'),
      updatedAt: new Date('2026-04-21T00:00:30Z'),
    }

    const result = await buildContext({
      groupId: 1,
      messageId: 1002,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '继续' }],
    } satisfies IncomingMessage, 10, {}, {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'sender:20',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getRecentMessages: async () => [message],
      listActionRecords: async () => [actionRecord],
    })

    assert.match(result.contextText, /\[BOT\] 机器人回复/)
  })

  test('private context state is keyed by scene instead of colliding with same-number group state', async () => {
    let conversationStateArgs: { groupId: number; senderThreadKey: string } | null = null
    let recentSceneArgs: { sceneKind: string; sceneExternalId: string; limit: number } | null = null
    let actionSceneId: string | null = null

    await buildContext({
      groupId: 20,
      sceneKind: 'qq_private',
      sceneExternalId: '20',
      sceneId: 'qq_private:20',
      messageId: 2001,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '私聊消息' }],
    } satisfies IncomingMessage, 10, {}, {
      getConversationState: async (groupId, senderThreadKey) => {
        conversationStateArgs = { groupId, senderThreadKey }
        return {
          id: 1,
          groupId,
          senderThreadKey,
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }
      },
      getRecentSceneMessages: async (sceneKind, sceneExternalId, limit) => {
        recentSceneArgs = { sceneKind, sceneExternalId: String(sceneExternalId), limit }
        return []
      },
      listActionRecords: async (sceneId) => {
        actionSceneId = sceneId
        return []
      },
    })

    assert.deepEqual(conversationStateArgs, {
      groupId: 0,
      senderThreadKey: 'qq_private:20:sender:20',
    })
    assert.deepEqual(recentSceneArgs, {
      sceneKind: 'qq_private',
      sceneExternalId: '20',
      limit: 10,
    })
    assert.equal(actionSceneId, 'qq_private:20')
  })
})
