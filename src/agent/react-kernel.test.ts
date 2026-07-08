import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient, LlmCallInput, LlmCallOutput } from './llm-client.js'
import type { Tool, ToolExecutionResult, ToolExecutor } from './tool.js'
import { runReactRound } from './react-kernel.js'

function makeTool(name: string, schema = z.object({})): Tool {
  return {
    name,
    description: `${name} test tool`,
    schema,
    async execute() {
      return { content: '{"ok":true}' }
    },
  }
}

describe('runReactRound', () => {
  test('calls LLM with durable messages and visible tools, then appends assistant tool calls and tool results', async () => {
    const context = createAgentContext()
    context.appendUserMessage('hello')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const executionOrder: string[] = []
    const toolCall = { id: 'lookup-1', name: 'lookup', args: { query: 'hello' } }

    const llm: LlmClient = {
      async chat(input: LlmCallInput): Promise<LlmCallOutput> {
        assert.equal(input.systemPrompt, 'system')
        assert.deepEqual(input.messages, [{ role: 'user', content: 'hello' }])
        assert.deepEqual(input.tools.map((tool) => tool.name), ['lookup'])
        return {
          content: 'thinking should not be persisted',
          toolCalls: [toolCall],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('lookup', z.object({ query: z.string() }))],
      async execute(call, ctx): Promise<ToolExecutionResult> {
        executionOrder.push(`${ctx.roundIndex}:${call.name}`)
        return { content: '{"ok":true}' }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 7 },
    })

    assert.deepEqual(executionOrder, ['7:lookup'])
    assert.equal(result.inputTokens, 10)
    assert.equal(result.tokensUsed, 15)
    assert.deepEqual(result.effects, [])
    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', toolCallId: 'lookup-1', content: '{"ok":true}' },
    ])
  })

  test('does not append an assistant turn when the LLM returns no tool calls', async () => {
    const context = createAgentContext()
    context.appendUserMessage('hello')
    const eventQueue = new InMemoryEventQueue<BotEvent>()

    const llm: LlmClient = {
      async chat(): Promise<LlmCallOutput> {
        return {
          content: 'plain assistant text',
          toolCalls: [],
          usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 6 },
          model: 'mock',
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [],
      async execute(): Promise<ToolExecutionResult> {
        assert.fail('no tool should execute when the LLM returns no tool calls')
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 1 },
    })

    assert.equal(result.inputTokens, 4)
    assert.equal(result.tokensUsed, 10)
    assert.deepEqual(result.effects, [])
    assert.deepEqual(context.getSnapshot().messages, [{ role: 'user', content: 'hello' }])
  })

  test('returns pause effect but only appends tool result content to AgentContext', async () => {
    const context = createAgentContext()
    context.appendUserMessage('pause now')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const toolCall = { id: 'pause-1', name: 'pause', args: { action: 'rest' } }

    const llm: LlmClient = {
      async chat(): Promise<LlmCallOutput> {
        return {
          content: '',
          toolCalls: [toolCall],
          usage: { inputTokens: 3, cachedTokens: 0, outputTokens: 2 },
          model: 'mock',
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('pause', z.object({ action: z.literal('rest') }))],
      async execute(): Promise<ToolExecutionResult> {
        return {
          content: '{"ok":true,"action":"rest"}',
          effects: [{ type: 'pause' }],
        } satisfies ToolExecutionResult
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 2 },
    })

    assert.deepEqual(result.effects, [
      { toolCallId: 'pause-1', toolName: 'pause', effect: { type: 'pause' } },
    ])
    const messages = context.getSnapshot().messages
    assert.deepEqual(messages, [
      { role: 'user', content: 'pause now' },
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', toolCallId: 'pause-1', content: '{"ok":true,"action":"rest"}' },
    ])
    const toolMessage = messages[2]
    if (toolMessage?.role !== 'tool') {
      assert.fail('expected persisted pause result to be a tool message')
    }
    assert.equal('effects' in toolMessage, false)
  })

  test('appends deterministic error tool result when executor rejects after assistant turn is appended', async () => {
    const context = createAgentContext()
    context.appendUserMessage('lookup with failure')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const toolCall = { id: 'lookup-fail-1', name: 'lookup', args: { query: 'boom' } }

    const llm: LlmClient = {
      async chat(): Promise<LlmCallOutput> {
        return {
          content: '',
          toolCalls: [toolCall],
          usage: { inputTokens: 6, cachedTokens: 0, outputTokens: 4 },
          model: 'mock',
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('lookup', z.object({ query: z.string() }))],
      async execute(): Promise<ToolExecutionResult> {
        throw new Error('boom')
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 3 },
    })

    assert.equal(result.inputTokens, 6)
    assert.equal(result.tokensUsed, 10)
    assert.deepEqual(result.effects, [])
    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'lookup with failure' },
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      {
        role: 'tool',
        toolCallId: 'lookup-fail-1',
        content: JSON.stringify({
          ok: false,
          code: 'execution_failed',
          error: 'Tool execution failed: boom',
        }),
      },
    ])
  })
})
