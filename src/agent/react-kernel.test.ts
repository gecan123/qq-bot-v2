import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient, LlmCallInput, LlmCallOutput } from './llm-client.js'
import type { Tool, ToolExecutionResult, ToolExecutor } from './tool.js'
import { LlmOutputTruncatedError, resolveEffectiveToolName, runReactRound } from './react-kernel.js'
import { interpretToolEffects } from './effect-interpreter.js'

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

function classifyExclusive() {
  return { sideEffect: true, concurrency: 'exclusive' as const }
}

describe('runReactRound', () => {
  test('resolves invoke to its requested deferred tool for observability', () => {
    assert.equal(resolveEffectiveToolName({ id: '1', name: 'invoke', args: { tool: 'browser', args: {} } }), 'browser')
    assert.equal(resolveEffectiveToolName({ id: '2', name: 'invoke', args: {} }), 'invoke')
    assert.equal(resolveEffectiveToolName({ id: '3', name: 'inbox', args: {} }), 'inbox')
  })

  test('stages assistant tool calls and tool results without mutating the durable context', async () => {
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
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('lookup', z.object({ query: z.string() }))],
      classify: classifyExclusive,
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
    assert.deepEqual(result.toolOutcomes, [{
      toolCallId: 'lookup-1',
      requestedToolName: 'lookup',
      toolName: 'lookup',
      ok: true,
    }])
    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'hello' },
    ])
    assert.deepEqual(result.messagesToAppend, [
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', toolCallId: 'lookup-1', content: '{"ok":true}' },
    ])
  })

  test('persists assistant native thinking blocks with tool calls', async () => {
    const context = createAgentContext()
    context.appendUserMessage('use tool')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const toolCall = { id: 'lookup-thinking-1', name: 'lookup', args: { query: 'hello' } }

    const llm: LlmClient = {
      async chat(): Promise<LlmCallOutput> {
        return {
          content: '',
          nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
          toolCalls: [toolCall],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('lookup', z.object({ query: z.string() }))],
      classify: classifyExclusive,
      async execute(): Promise<ToolExecutionResult> {
        return { content: '{"ok":true}' }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 8 },
    })

    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'use tool' },
    ])
    assert.deepEqual(result.messagesToAppend, [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
        toolCalls: [toolCall],
      },
      { role: 'tool', toolCallId: 'lookup-thinking-1', content: '{"ok":true}' },
    ])
  })

  test('charges only uncached input plus output against the autonomy budget', async () => {
    const context = createAgentContext()
    context.appendUserMessage('cached context')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const llm: LlmClient = {
      async chat() {
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 100_000, cachedTokens: 99_000, outputTokens: 250 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools: { list: () => [], classify: classifyExclusive, async execute() { return { content: '{}' } } },
      toolContext: { eventQueue, roundIndex: 1 },
    })

    assert.equal(result.tokensUsed, 1_250)
  })

  test('retries one max_tokens response with a larger output budget before executing tools', async () => {
    const context = createAgentContext()
    context.appendUserMessage('finish the task')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const budgets: Array<number | undefined> = []
    let calls = 0
    let executions = 0
    const toolCall = { id: 'done-1', name: 'done', args: {} }
    const llm: LlmClient = {
      async chat(input) {
        budgets.push(input.maxOutputTokens)
        calls++
        if (calls === 1) {
          return {
            content: 'partial',
            toolCalls: [],
            usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 4_096 },
            model: 'mock',
            contextWindowTokens: 200_000,
            stopReason: 'max_tokens',
          }
        }
        return {
          content: '',
          toolCalls: [toolCall],
          usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 10 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'tool_use',
        }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools: {
        list: () => [makeTool('done')],
        classify: classifyExclusive,
        async execute() {
          executions++
          return { content: '{"ok":true}' }
        },
      },
      toolContext: { eventQueue, roundIndex: 9 },
    })

    assert.deepEqual(budgets, [undefined, 8_192])
    assert.equal(executions, 1)
    assert.equal(result.tokensUsed, 4_146)
    assert.equal(context.getSnapshot().messages.length, 1)
    assert.equal(result.messagesToAppend.length, 2)
  })

  test('never appends or executes a tool call from a still-truncated response', async () => {
    const context = createAgentContext()
    context.appendUserMessage('do not execute partial calls')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let calls = 0
    let executions = 0
    const llm: LlmClient = {
      async chat() {
        calls++
        return {
          content: calls === 1 ? 'partial one' : 'partial two',
          toolCalls: calls === 1 ? [] : [{ id: 'partial-1', name: 'dangerous', args: {} }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 8 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'max_tokens',
        }
      },
    }

    await assert.rejects(
      runReactRound({
        systemPrompt: 'system',
        context,
        llm,
      tools: {
        list: () => [makeTool('dangerous')],
        classify: classifyExclusive,
          async execute() {
            executions++
            return { content: '{"ok":true}' }
          },
        },
        toolContext: { eventQueue, roundIndex: 10 },
      }),
      LlmOutputTruncatedError,
    )

    assert.equal(executions, 0)
    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'do not execute partial calls' },
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
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [],
      classify: classifyExclusive,
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
    assert.equal(result.toolCallCount, 0)
    assert.deepEqual(result.effects, [])
    assert.deepEqual(result.messagesToAppend, [])
    assert.deepEqual(result.toolOutcomes, [])
    assert.deepEqual(context.getSnapshot().messages, [{ role: 'user', content: 'hello' }])
  })

  test('persists tool-result images as refs before returning the canonical append batch', async () => {
    const context = createAgentContext()
    context.appendUserMessage('render an image')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const llm: LlmClient = {
      async chat() {
        return {
          content: '',
          toolCalls: [{ id: 'image-1', name: 'render', args: {} }],
          usage: { inputTokens: 2, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'end_turn',
        }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools: {
        list: () => [makeTool('render')],
        classify: classifyExclusive,
        async execute() {
          return { content: [{
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/png', data: 'aW1hZ2U=' },
          }] }
        },
      },
      toolContext: { eventQueue, roundIndex: 11 },
      imageRefs: {
        async persist() {
          return { type: 'image_ref', mediaId: '77', mediaType: 'image/png' }
        },
        async resolve() { return null },
      },
    })

    assert.match(JSON.stringify(result.messagesToAppend), /"type":"image_ref"/)
    assert.doesNotMatch(JSON.stringify(result.messagesToAppend), /"type":"base64"/)
    assert.doesNotMatch(JSON.stringify(context.getSnapshot().messages), /"type":"base64"/)
  })

  test('returns pause effect separately from the staged tool result content', async () => {
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
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('pause', z.object({ action: z.literal('rest') }))],
      classify: classifyExclusive,
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
    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'pause now' },
    ])
    const messages = result.messagesToAppend
    assert.deepEqual(messages, [
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', toolCallId: 'pause-1', content: '{"ok":true,"action":"rest"}' },
    ])
    const toolMessage = messages[1]
    if (toolMessage?.role !== 'tool') {
      assert.fail('expected persisted pause result to be a tool message')
    }
    assert.equal('effects' in toolMessage, false)
  })

  test('trusts invoked send_message effects under the effective tool identity', async () => {
    const context = createAgentContext()
    context.appendUserMessage('send it')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const toolCall = {
      id: 'send-1',
      name: 'invoke',
      args: { tool: 'send_message', args: { message: 'hi' } },
    }
    const llm: LlmClient = {
      async chat() {
        return {
          content: '',
          toolCalls: [toolCall],
          usage: { inputTokens: 3, cachedTokens: 0, outputTokens: 2 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const tools: ToolExecutor = {
      list: () => [makeTool('invoke')],
      classify: classifyExclusive,
      async execute() {
        return {
          content: '{"ok":true}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 123 } }],
        }
      },
    }

    const round = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 2 },
    })

    assert.deepEqual(round.effects, [{
      toolCallId: 'send-1',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
    }])
    assert.deepEqual(interpretToolEffects(round.effects).sentTargets, [
      { type: 'private', userId: 123 },
    ])
  })

  test('stages deterministic error tool result when executor rejects', async () => {
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
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools: ToolExecutor = {
      list: () => [makeTool('lookup', z.object({ query: z.string() }))],
      classify: classifyExclusive,
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
    ])
    assert.deepEqual(result.messagesToAppend, [
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

  test('parallelizes consecutive explicit reads but keeps side effects as ordering barriers', async () => {
    const context = createAgentContext()
    context.appendUserMessage('run mixed tools')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const calls = [
      { id: 'read-1', name: 'inbox', args: { action: 'list' } },
      { id: 'read-2', name: 'qq_directory', args: { action: 'list_groups' } },
      { id: 'write-1', name: 'send_message', args: { text: 'done' } },
      { id: 'read-3', name: 'skill', args: { action: 'list' } },
    ]
    const execution: string[] = []
    let activeReads = 0
    let maxActiveReads = 0
    let releaseReads!: () => void
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve })
    const llm: LlmClient = {
      async chat() {
        return {
          content: '',
          toolCalls: calls,
          usage: { inputTokens: 5, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'tool_use',
        }
      },
    }
    const tools: ToolExecutor = {
      list: () => calls.map((item) => makeTool(item.name)),
      classify: (call) => ({
        sideEffect: call.name === 'send_message',
        concurrency: call.name === 'send_message' ? 'exclusive' : 'parallel',
      }),
      async execute(call) {
        execution.push(`start:${call.id}`)
        if (call.id === 'read-1' || call.id === 'read-2') {
          activeReads++
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          if (activeReads === 2) releaseReads()
          await readGate
          activeReads--
        }
        if (call.id === 'write-1') {
          assert.equal(activeReads, 0, 'write must wait for the preceding read batch')
        }
        if (call.id === 'read-3') {
          assert.equal(execution.includes('start:write-1'), true, 'later read must stay behind write')
        }
        execution.push(`end:${call.id}`)
        return { content: JSON.stringify({ ok: true, id: call.id }) }
      },
    }

    const result = await runReactRound({
      systemPrompt: 'system',
      context,
      llm,
      tools,
      toolContext: { eventQueue, roundIndex: 12 },
    })

    assert.equal(maxActiveReads, 2)
    assert.deepEqual(
      result.messagesToAppend.filter((message) => message.role === 'tool').map((message) => (
        message.role === 'tool' ? message.toolCallId : ''
      )),
      ['read-1', 'read-2', 'write-1', 'read-3'],
      'staged tool results must remain in assistant call order',
    )
  })
})
