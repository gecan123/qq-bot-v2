import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createToolExecutor, type Tool } from './tool.js'
import {
  createGenerateImageTaskLogHook,
  createSendMessageAiToneHook,
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
  target: z.union([
    z.object({ type: z.literal('group'), groupId: z.number().int() }),
    z.object({ type: z.literal('private'), userId: z.number().int() }),
  ]),
  text: z.string().nullable().optional(),
})

function createFakeSendTool(calls: unknown[]): Tool<z.infer<typeof sendMessageSchema>> {
  return {
    name: 'send_message',
    description: 'send',
    schema: sendMessageSchema,
    async execute(args) {
      calls.push(args)
      return { content: JSON.stringify({ ok: true, sent: true }) }
    },
  }
}

describe('createSendMessageAiToneHook', () => {
  test('blocks the first two AI-tone group sends and then allows the third consecutive over-threshold send', async () => {
    const calls: unknown[] = []
    const logs: AiTonePrecheckLogEntry[] = []
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [createSendMessageAiToneHook({
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
      target: { type: 'group', groupId: 111 },
      text: '综合来看，这个问题需要从多个维度系统性分析一下。',
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
      args: { target: { type: 'group', groupId: 111 }, text: '综合来看，这件事需要系统性分析一下。' },
    }, makeCtx())
    isAI = false
    await exec.execute({
      id: 'c2',
      name: 'send_message',
      args: { target: { type: 'group', groupId: 111 }, text: '就这么回事，先别上价值。' },
    }, makeCtx())
    isAI = true
    await exec.execute({
      id: 'c3',
      name: 'send_message',
      args: { target: { type: 'group', groupId: 111 }, text: '综合来看，这件事需要系统性分析一下。' },
    }, makeCtx())

    assert.equal(calls.length, 1)
    assert.deepEqual(logs.map((entry) => entry.decision), ['blocked', 'allowed', 'blocked'])
    assert.deepEqual(logs.map((entry) => entry.consecutiveBlocked), [1, 0, 1])
  })

  test('runs the AI-tone precheck for private and very short sends', async () => {
    const calls: unknown[] = []
    const logs: AiTonePrecheckLogEntry[] = []
    let predictionCalls = 0
    const exec = createToolExecutor([createFakeSendTool(calls)], {
      hooks: {
        beforeTool: [createSendMessageAiToneHook({
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
      args: { target: { type: 'private', userId: 123 }, text: '综合来看，这个回复也可能很 AI。' },
    }, makeCtx())
    const shortGroupResult = await exec.execute({
      id: 'short',
      name: 'send_message',
      args: { target: { type: 'group', groupId: 111 }, text: '别急' },
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
