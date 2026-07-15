import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { LlmCallInput, LlmClient } from '../llm-client.js'
import { createTaskScheduler } from '../task-scheduler.js'
import type { Tool } from '../tool.js'
import { createDelegateTool } from './delegate.js'

function makeCtx() {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 7 }
}

describe('delegate tool', () => {
  test('runs in a clean context with only selected safe tools and returns a background result', async () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'delegate-1' })
    const scheduler = createTaskScheduler({ delegate: { concurrency: 1 } })
    const seen: LlmCallInput[] = []
    let llmCalls = 0
    let lookupCalls = 0
    const llm: LlmClient = {
      async chat(input) {
        seen.push(input)
        llmCalls++
        if (llmCalls === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'lookup-1', name: 'ai_tone', args: { text: 'hello' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2 },
            model: 'mock',
            contextWindowTokens: 200_000,
            stopReason: 'tool_use',
          }
        }
        return {
          content: '',
          toolCalls: [{
            id: 'return-1',
            name: 'delegate_return',
            args: { summary: '完成分析', result: '这是结构化结论' },
          }],
          usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 3 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'tool_use',
        }
      },
    }
    const safeTool: Tool = {
      name: 'ai_tone',
      description: 'readonly tone',
      schema: z.object({ text: z.string() }),
      async execute() {
        lookupCalls++
        return { content: '{"tone":"neutral"}' }
      },
    }
    const tool = createDelegateTool({ llm, taskRegistry: registry, taskScheduler: scheduler, safeTools: [safeTool] })
    const ctx = makeCtx()

    const started = JSON.parse(String((await tool.execute({
      task: '只分析 hello，不要看主上下文秘密',
      allowedTools: ['ai_tone'],
      maxRounds: 3,
      timeoutSeconds: 30,
    }, ctx)).content))
    await scheduler.drain()

    assert.equal(started.taskId, 'delegate-1')
    assert.equal(lookupCalls, 1)
    assert.deepEqual(seen[0]?.messages, [
      { role: 'user', content: '只分析 hello，不要看主上下文秘密' },
    ])
    assert.deepEqual(seen[0]?.tools.map((entry) => entry.name), ['ai_tone', 'delegate_return'])
    assert.equal(seen.some((input) => input.tools.some((entry) => entry.name === 'send_message')), false)
    assert.equal(registry.get('delegate-1')?.status, 'completed')
    assert.deepEqual(registry.get('delegate-1')?.resultData, {
      summary: '完成分析',
      result: '这是结构化结论',
      rounds: 2,
      allowedTools: ['ai_tone'],
    })
    assert.equal(ctx.eventQueue.dequeue()?.type, 'background_task_completed')
  })

  test('rejects a fixed-allowlist tool that is unavailable in this runtime', async () => {
    const registry = createInMemoryTaskRegistry()
    const scheduler = createTaskScheduler({ delegate: { concurrency: 1 } })
    const tool = createDelegateTool({
      llm: { async chat() { throw new Error('must not call') } },
      taskRegistry: registry,
      taskScheduler: scheduler,
      safeTools: [],
    })

    const result = JSON.parse(String((await tool.execute({
      task: 'read inbox',
      allowedTools: ['inbox'],
    }, makeCtx())).content))

    assert.equal(result.ok, false)
    assert.equal(result.code, 'delegate_tool_unavailable')
    assert.equal(registry.listRunning().length, 0)
  })

  test('fails with a bounded terminal state when delegate_return is never called', async () => {
    const registry = createInMemoryTaskRegistry({ idFactory: () => 'delegate-bounded' })
    const scheduler = createTaskScheduler({ delegate: { concurrency: 1 } })
    const tool = createDelegateTool({
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
            stopReason: 'end_turn',
          }
        },
      },
      taskRegistry: registry,
      taskScheduler: scheduler,
      safeTools: [],
    })

    await tool.execute({ task: 'never return', maxRounds: 2 }, makeCtx())
    await scheduler.drain()

    assert.equal(registry.get('delegate-bounded')?.status, 'failed')
    assert.equal(registry.get('delegate-bounded')?.error, 'delegate_max_rounds_exceeded:2')
  })
})
