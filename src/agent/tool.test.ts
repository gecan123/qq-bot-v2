import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createToolExecutor, type Tool } from './tool.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'

function makeCtx() {
  return {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 0,
  }
}

describe('createToolExecutor', () => {
  test('writes a redacted tool trace for successful calls', async () => {
    const writes: string[] = []
    const echo: Tool<{ text: string; apiKey: string; target: { type: 'private'; userId: number } }> = {
      name: 'send_message',
      description: 'send',
      schema: z.object({
        text: z.string(),
        apiKey: z.string(),
        target: z.object({ type: z.literal('private'), userId: z.number() }),
      }),
      async execute(args) {
        return { content: args.text }
      },
    }
    const exec = createToolExecutor([echo], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: (() => {
          const values = [100, 145]
          return () => values.shift() ?? 145
        })(),
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute(
      {
        id: 'call_1',
        name: 'send_message',
        args: {
          text: 'hello',
          apiKey: 'secret-token',
          target: { type: 'private', userId: 123456 },
        },
      },
      { ...makeCtx(), roundIndex: 7 },
    )

    assert.equal(writes.length, 1)
    const entry = JSON.parse(writes[0]!.trim())
    assert.equal(entry.ts, '2026-05-25T12:00:00.000Z')
    assert.equal(entry.toolCallId, 'call_1')
    assert.equal(entry.toolName, 'send_message')
    assert.equal(entry.roundIndex, 7)
    assert.equal(entry.durationMs, 45)
    assert.equal(entry.ok, true)
    assert.equal(entry.sideEffect, true)
    assert.equal(entry.argsSummary.apiKey, '[REDACTED]')
    assert.equal(entry.argsSummary.target.userId, '[REDACTED]')
    assert.equal(entry.argsSummary.text, 'hello')
  })

  test('writes a failed tool trace for invalid args without entering AgentContext-specific content', async () => {
    const writes: string[] = []
    const inc: Tool<{ n: number }> = {
      name: 'inc',
      description: 'inc',
      schema: z.object({ n: z.number() }),
      async execute(args) {
        return { content: String(args.n + 1) }
      },
    }
    const exec = createToolExecutor([inc], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: (() => {
          const values = [200, 203]
          return () => values.shift() ?? 203
        })(),
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    const result = await exec.execute(
      { id: 'call_bad', name: 'inc', args: { n: 'nope' } },
      { ...makeCtx(), roundIndex: 8 },
    )

    assert.match(result.content as string, /Invalid tool arguments/)
    assert.equal(writes.length, 1)
    const entry = JSON.parse(writes[0]!.trim())
    assert.equal(entry.toolName, 'inc')
    assert.equal(entry.roundIndex, 8)
    assert.equal(entry.durationMs, 3)
    assert.equal(entry.ok, false)
    assert.equal(entry.sideEffect, false)
    assert.equal(entry.error, 'Invalid tool arguments')
  })

  test('routes call to correct tool by name and validates args', async () => {
    const echo: Tool<{ msg: string }> = {
      name: 'echo',
      description: 'echo input',
      schema: z.object({ msg: z.string() }),
      async execute(args) {
        return { content: args.msg }
      },
    }
    const exec = createToolExecutor([echo])

    const result = await exec.execute(
      { id: 'c1', name: 'echo', args: { msg: 'hi' } },
      makeCtx(),
    )
    assert.equal(result.content, 'hi')
  })

  test('returns error envelope for unknown tool', async () => {
    const exec = createToolExecutor([])
    const result = await exec.execute({ id: 'c1', name: 'nope', args: {} }, makeCtx())
    assert.match(result.content as string, /Unknown tool/)
  })

  test('invalid args produce structured error, not throw', async () => {
    const t: Tool<{ n: number }> = {
      name: 'inc',
      description: 'inc',
      schema: z.object({ n: z.number() }),
      async execute(args) {
        return { content: String(args.n + 1) }
      },
    }
    const exec = createToolExecutor([t])
    const result = await exec.execute(
      { id: 'c1', name: 'inc', args: { n: 'not a number' } },
      makeCtx(),
    )
    assert.match(result.content as string, /Invalid tool arguments/)
  })

  test('thrown errors inside execute become tool error envelope', async () => {
    const t: Tool<Record<string, never>> = {
      name: 'boom',
      description: 'always throws',
      schema: z.object({}),
      async execute() {
        throw new Error('kaboom')
      },
    }
    const exec = createToolExecutor([t])
    const result = await exec.execute({ id: 'c1', name: 'boom', args: {} }, makeCtx())
    assert.match(result.content as string, /Tool execution failed: kaboom/)
  })

  test('duplicate tool name in registration throws', () => {
    const a: Tool<Record<string, never>> = {
      name: 'dup',
      description: '',
      schema: z.object({}),
      async execute() {
        return { content: 'a' }
      },
    }
    assert.throws(() => createToolExecutor([a, a]), /Duplicate tool name: dup/)
  })
})
