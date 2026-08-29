import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createToolExecutor, type Tool } from './tool.js'
import {
  createGenerateImageTaskLogHook,
  createSendMessageSafetyGuard,
  type GenerateImageTaskLogEntry,
} from './tool-policy-hooks.js'
import type { ConversationRef } from '../chat/conversation.js'

function makeCtx() {
  return {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 0,
  }
}

const sendMessageSchema = z.object({
  message: z.string().nullable().optional(),
  reply_to: z.object({
    row_id: z.number().int().positive(),
    expect: z.enum(['message', 'mentioned_self']),
  }).optional(),
  work: z.discriminatedUnion('state', [
    z.object({ state: z.literal('none') }),
    z.object({ state: z.literal('continue') }),
  ]).optional(),
})

function createFakeSendTool(
  calls: unknown[],
  effectTarget: ConversationRef = {
    platform: 'qq', accountId: '999', kind: 'private', externalId: '123',
  },
): Tool<z.infer<typeof sendMessageSchema>> {
  return {
    name: 'send_message',
    description: 'send',
    schema: sendMessageSchema,
    async execute(args, _ctx) {
      calls.push(args)
      return {
        content: JSON.stringify({ ok: true, sent: true }),
        effects: [{ type: 'message_sent', target: effectTarget }],
      }
    },
  }
}

describe('createSendMessageSafetyGuard', () => {
  test('guards successful ambient sends while exempting replies and rejected attempts', async () => {
    const calls: unknown[] = []
    let nowMs = Date.parse('2026-07-14T12:00:00.000Z')
    const target = {
      platform: 'qq' as const, accountId: '999', kind: 'private' as const, externalId: '123',
    }
    const guard = createSendMessageSafetyGuard({
      nowMs: () => nowMs,
      getCurrentTarget: () => target,
    })
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [guard.beforeTool],
        afterTool: [guard.afterTool],
      },
    })
    const first = await exec.execute({
      id: 'first', name: 'send_message', args: { message: '第一句' },
    }, makeCtx())
    const cooldown = await exec.execute({
      id: 'cooldown', name: 'send_message', args: { message: '第二句' },
    }, makeCtx())
    nowMs += 30 * 60_000
    const afterCooldown = await exec.execute({
      id: 'after-cooldown', name: 'send_message', args: { message: '第二句' },
    }, makeCtx())
    nowMs += 30 * 60_000
    const duplicate = await exec.execute({
      id: 'duplicate', name: 'send_message', args: { message: '第一句' },
    }, makeCtx())
    const reply = await exec.execute({
      id: 'reply', name: 'send_message', args: {
        message: '第一句',
        reply_to: { row_id: 456, expect: 'message' },
      },
    }, makeCtx())
    nowMs += 12 * 60 * 60_000
    const afterDuplicateWindow = await exec.execute({
      id: 'after-window', name: 'send_message', args: { message: '第一句' },
    }, makeCtx())

    assert.equal(JSON.parse(first.content as string).ok, true)
    assert.equal(JSON.parse(cooldown.content as string).code, 'private_ambient_cooldown')
    assert.equal(JSON.parse(afterCooldown.content as string).ok, true)
    assert.equal(JSON.parse(duplicate.content as string).code, 'ambient_duplicate')
    assert.equal(JSON.parse(reply.content as string).ok, true)
    assert.equal(JSON.parse(afterDuplicateWindow.content as string).ok, true)
    assert.equal(calls.length, 4)
  })

  test('treats a send to a pending private mailbox as a reply without requiring reply_to', async () => {
    const calls: unknown[] = []
    let pendingExternalId: string | null = null
    const target = {
      platform: 'qq' as const, accountId: '999', kind: 'private' as const, externalId: '123',
    }
    const guard = createSendMessageSafetyGuard({
      getCurrentTarget: () => target,
      hasPendingPrivateMailbox: (conversation) => conversation.externalId === pendingExternalId,
    })
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [guard.beforeTool],
        afterTool: [guard.afterTool],
      },
    })

    await exec.execute({
      id: 'ambient', name: 'send_message', args: { message: '早上好' },
    }, makeCtx())
    pendingExternalId = '123'
    const response = await exec.execute({
      id: 'response', name: 'send_message', args: { message: '我今天想继续看那篇论文' },
    }, makeCtx())
    pendingExternalId = null
    const ambientAgain = await exec.execute({
      id: 'ambient-again', name: 'send_message', args: { message: '又想起一件事' },
    }, makeCtx())

    assert.equal(JSON.parse(response.content as string).ok, true)
    assert.equal(JSON.parse(ambientAgain.content as string).code, 'private_ambient_cooldown')
    assert.equal(calls.length, 2)
  })
})

describe('createGenerateImageTaskLogHook', () => {
  test('logs task metadata after generate_image starts a background task', async () => {
    const logs: GenerateImageTaskLogEntry[] = []
    const generateImage: Tool<{ prompt: string; quality?: 'low' | 'medium' | 'high' }> = {
      name: 'generate_image',
      description: 'generate',
      schema: z.object({
        prompt: z.string(),
        quality: z.enum(['low', 'medium', 'high']).optional(),
      }),
      async execute() {
        return {
          content: JSON.stringify({
            ok: true,
            status: 'started',
            taskId: 'task-123',
            description: '生成图片: A very detailed prompt',
          }),
        }
      },
    }
    const exec = createToolExecutor([generateImage], {
      hooks: {
        afterTool: [createGenerateImageTaskLogHook({
          logger: (entry) => logs.push(entry),
        })],
      },
    })

    await exec.execute({
      id: 'img_1',
      name: 'generate_image',
      args: {
        prompt: 'A very detailed prompt for a cat sitting under neon lights',
        quality: 'medium',
      },
    }, { ...makeCtx(), roundIndex: 9 })

    assert.deepEqual(logs, [{
      toolCallId: 'img_1',
      roundIndex: 9,
      taskId: 'task-123',
      description: '生成图片: A very detailed prompt',
      quality: 'medium',
      promptPreview: 'A very detailed prompt for a cat sitting under neon lights',
    }])
  })

  test('does not log failed or non-started generate_image results', async () => {
    const logs: GenerateImageTaskLogEntry[] = []
    const generateImage: Tool<{ prompt: string }> = {
      name: 'generate_image',
      description: 'generate',
      schema: z.object({ prompt: z.string() }),
      async execute() {
        return { content: JSON.stringify({ ok: false, error: 'failed before task registration' }) }
      },
    }
    const exec = createToolExecutor([generateImage], {
      hooks: {
        afterTool: [createGenerateImageTaskLogHook({
          logger: (entry) => logs.push(entry),
        })],
      },
    })

    await exec.execute({
      id: 'img_failed',
      name: 'generate_image',
      args: { prompt: 'A prompt' },
    }, makeCtx())

    assert.deepEqual(logs, [])
  })
})
