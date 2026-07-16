import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createToolExecutor, type Tool } from './tool.js'
import {
  createGenerateImageTaskLogHook,
  createSendMessageAiToneHook,
  createSendMessageSafetyGuard,
  type AiTonePrecheckLogEntry,
  type GenerateImageTaskLogEntry,
} from './tool-policy-hooks.js'

function makeCtx() {
  return {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 0,
  }
}

const sendMessageSchema = z.object({
  message: z.string().nullable().optional(),
  reply_to: z.number().int().positive().optional(),
})

function createFakeSendTool(
  calls: unknown[],
  effectTarget: { type: 'group'; groupId: number } | { type: 'private'; userId: number } = {
    type: 'private',
    userId: 123,
  },
): Tool<z.infer<typeof sendMessageSchema>> {
  return {
    name: 'send_message',
    description: 'send',
    schema: sendMessageSchema,
    async execute(args) {
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
    const target = { type: 'private' as const, userId: 123 }
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
        reply_to: 456,
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
    let pendingUserId: number | null = null
    const target = { type: 'private' as const, userId: 123 }
    const guard = createSendMessageSafetyGuard({
      getCurrentTarget: () => target,
      hasPendingPrivateMailbox: (userId) => userId === pendingUserId,
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
    pendingUserId = 123
    const response = await exec.execute({
      id: 'response', name: 'send_message', args: { message: '我今天想继续看那篇论文' },
    }, makeCtx())
    pendingUserId = null
    const ambientAgain = await exec.execute({
      id: 'ambient-again', name: 'send_message', args: { message: '又想起一件事' },
    }, makeCtx())

    assert.equal(JSON.parse(response.content as string).ok, true)
    assert.equal(JSON.parse(ambientAgain.content as string).code, 'private_ambient_cooldown')
    assert.equal(calls.length, 2)
  })
})

describe('createSendMessageAiToneHook', () => {
  test('blocks the first two AI-tone group sends and then allows the third consecutive over-threshold send', async () => {
    const calls: unknown[] = []
    const logs: AiTonePrecheckLogEntry[] = []
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [createSendMessageAiToneHook({
          getCurrentTarget: () => ({ type: 'group', groupId: 111 }),
          predict: (text, threshold) => ({
            prob: 0.91,
            isAI: true,
            label: 'AI味',
            threshold: threshold ?? 0.75,
            textLength: Array.from(text).length,
          }),
          logger: (entry) => logs.push(entry),
        })],
      },
    })

    const args = {
      message: '综合来看，这个问题需要从多个维度系统性分析一下。',
    }

    const first = await exec.execute({ id: 'c1', name: 'send_message', args }, makeCtx())
    const second = await exec.execute({ id: 'c2', name: 'send_message', args }, makeCtx())
    const third = await exec.execute({ id: 'c3', name: 'send_message', args }, makeCtx())

    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(first.content as string).ok, false)
    assert.equal(JSON.parse(second.content as string).ok, false)
    assert.equal(JSON.parse(third.content as string).ok, true)
    assert.deepEqual(logs.map((entry) => entry.decision), ['blocked', 'blocked', 'allowed_after_limit'])
    assert.deepEqual(logs.map((entry) => entry.consecutiveBlocked), [1, 2, 2])
  })

  test('logs and allows group sends that are below threshold, resetting the consecutive block count', async () => {
    const calls: unknown[] = []
    const logs: AiTonePrecheckLogEntry[] = []
    let isAI = true
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [createSendMessageAiToneHook({
          getCurrentTarget: () => ({ type: 'group', groupId: 111 }),
          predict: (text, threshold) => ({
            prob: isAI ? 0.9 : 0.2,
            isAI,
            label: isAI ? 'AI味' : '人味',
            threshold: threshold ?? 0.75,
            textLength: Array.from(text).length,
          }),
          logger: (entry) => logs.push(entry),
        })],
      },
    })

    await exec.execute({
      id: 'c1',
      name: 'send_message',
      args: { message: '综合来看，这件事需要系统性分析一下。' },
    }, makeCtx())
    isAI = false
    await exec.execute({
      id: 'c2',
      name: 'send_message',
      args: { message: '就这么回事，先别上价值。' },
    }, makeCtx())
    isAI = true
    await exec.execute({
      id: 'c3',
      name: 'send_message',
      args: { message: '综合来看，这件事需要系统性分析一下。' },
    }, makeCtx())

    assert.equal(calls.length, 1)
    assert.deepEqual(logs.map((entry) => entry.decision), ['blocked', 'allowed', 'blocked'])
    assert.deepEqual(logs.map((entry) => entry.consecutiveBlocked), [1, 0, 1])
  })

  test('runs the AI-tone precheck for private and very short sends', async () => {
    const calls: unknown[] = []
    const logs: AiTonePrecheckLogEntry[] = []
    let predictionCalls = 0
    let currentTarget: { type: 'private'; userId: number } | { type: 'group'; groupId: number } = {
      type: 'private',
      userId: 123,
    }
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [createSendMessageAiToneHook({
          getCurrentTarget: () => currentTarget,
          predict: () => {
            predictionCalls++
            return { prob: 1, isAI: true, label: 'AI味', threshold: 0.75, textLength: 20 }
          },
          logger: (entry) => logs.push(entry),
        })],
      },
    })

    const privateResult = await exec.execute({
      id: 'private',
      name: 'send_message',
      args: { message: '综合来看，这个回复也可能很 AI。' },
    }, makeCtx())
    currentTarget = { type: 'group', groupId: 111 }
    const shortGroupResult = await exec.execute({
      id: 'short',
      name: 'send_message',
      args: { message: '别急' },
    }, makeCtx())

    assert.equal(calls.length, 0)
    assert.equal(JSON.parse(privateResult.content as string).ok, false)
    assert.equal(JSON.parse(shortGroupResult.content as string).ok, false)
    assert.equal(predictionCalls, 2)
    assert.deepEqual(logs.map((entry) => entry.targetType), ['private', 'group'])
    assert.equal((logs[0] as AiTonePrecheckLogEntry & { userId?: number }).userId, 123)
    assert.equal(logs[1]!.groupId, 111)
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
