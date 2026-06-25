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

  test('classifies merged memory side effects by action', async () => {
    const writes: string[] = []
    const memory: Tool<{ action: 'write' | 'search' }> = {
      name: 'memory',
      description: 'memory',
      schema: z.object({ action: z.enum(['write', 'search']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([memory], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'write', name: 'memory', args: { action: 'write' } }, makeCtx())
    await exec.execute({ id: 'search', name: 'memory', args: { action: 'search' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, true)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
  })

  test('classifies fetch_content image actions as side effects', async () => {
    const writes: string[] = []
    const fetchContent: Tool<{ action: 'url' | 'image_url' | 'qq_avatar' }> = {
      name: 'fetch_content',
      description: 'fetch content',
      schema: z.object({ action: z.enum(['url', 'image_url', 'qq_avatar']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([fetchContent], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'url', name: 'fetch_content', args: { action: 'url' } }, makeCtx())
    await exec.execute({ id: 'image', name: 'fetch_content', args: { action: 'image_url' } }, makeCtx())
    await exec.execute({ id: 'avatar', name: 'fetch_content', args: { action: 'qq_avatar' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, false)
    assert.equal(JSON.parse(writes[1]!).sideEffect, true)
    assert.equal(JSON.parse(writes[2]!).sideEffect, true)
  })

  test('classifies workspace_bash side effects by command', async () => {
    const writes: string[] = []
    const workspaceBash: Tool<{ cwd?: 'workspace' | 'repo'; command: string }> = {
      name: 'workspace_bash',
      description: 'workspace bash',
      schema: z.object({
        cwd: z.enum(['workspace', 'repo']).optional(),
        command: z.string(),
      }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([workspaceBash], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'repo-read', name: 'workspace_bash', args: { cwd: 'repo', command: 'rg "foo" src' } }, makeCtx())
    await exec.execute({ id: 'journal-list', name: 'workspace_bash', args: { command: 'journal list' } }, makeCtx())
    await exec.execute({ id: 'journal-write', name: 'workspace_bash', args: { command: 'journal write diary hi' } }, makeCtx())
    await exec.execute({ id: 'redirect', name: 'workspace_bash', args: { command: 'printf hi > notes/today.md' } }, makeCtx())
    await exec.execute({ id: 'fetch-url', name: 'workspace_bash', args: { command: 'fetch url https://example.com' } }, makeCtx())
    await exec.execute({ id: 'fetch-image', name: 'workspace_bash', args: { command: 'fetch image https://example.com/cat.png' } }, makeCtx())
    await exec.execute({ id: 'unknown', name: 'workspace_bash', args: { command: 'curl https://example.com' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, false)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, true)
    assert.equal(JSON.parse(writes[3]!).sideEffect, true)
    assert.equal(JSON.parse(writes[4]!).sideEffect, false)
    assert.equal(JSON.parse(writes[5]!).sideEffect, true)
    assert.equal(JSON.parse(writes[6]!).sideEffect, true)
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

  test('beforeTool hook can block execution with a tool result', async () => {
    let executed = false
    const tool: Tool<{ text?: string }> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string().optional() }),
      async execute() {
        executed = true
        return { content: 'executed' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        beforeTool: [() => ({ content: JSON.stringify({ ok: false, error: 'blocked' }) })],
      },
    })

    const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

    assert.equal(executed, false)
    assert.match(result.content as string, /blocked/)
  })

  test('beforeTool hook receives normalized args', async () => {
    let seen: unknown
    const tool: Tool<{ value?: string }> = {
      name: 'optional',
      description: 'optional',
      schema: z.object({ value: z.string().optional() }),
      async execute() {
        return { content: 'ok' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        beforeTool: [(ctx) => {
          seen = ctx.call.args
        }],
      },
    })

    await exec.execute({ id: 'c1', name: 'optional', args: { value: null } }, makeCtx())

    assert.deepEqual(seen, {})
  })

  test('beforeTool hook errors become structured tool errors', async () => {
    const tool: Tool<Record<string, never>> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({}),
      async execute() {
        return { content: 'executed' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        beforeTool: [() => {
          throw new Error('policy exploded')
        }],
      },
    })

    const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

    assert.match(result.content as string, /Tool hook failed: policy exploded/)
  })

  test('afterTool hook runs after successful tool execution', async () => {
    const events: string[] = []
    const tool: Tool<Record<string, never>> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({}),
      async execute() {
        events.push('execute')
        return { content: 'ok' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        afterTool: [({ result }) => {
          events.push(`after:${result.content}`)
        }],
      },
    })

    await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

    assert.deepEqual(events, ['execute', 'after:ok'])
  })

  test('afterTool hook failure preserves original tool result', async () => {
    const tool: Tool<Record<string, never>> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({}),
      async execute() {
        return { content: 'ok' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        afterTool: [() => {
          throw new Error('after exploded')
        }],
      },
    })

    const result = await exec.execute({ id: 'c1', name: 'echo', args: {} }, makeCtx())

    assert.equal(result.content, 'ok')
  })

  test('traces hook-blocked calls once with normalized args', async () => {
    const writes: string[] = []
    const tool: Tool<{ value?: string }> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({ value: z.string().optional() }),
      async execute() {
        return { content: 'executed' }
      },
    }
    const exec = createToolExecutor([tool], {
      hooks: {
        beforeTool: [() => ({ content: JSON.stringify({ ok: false, error: 'blocked' }) })],
      },
      trace: {
        now: () => new Date('2026-06-25T00:00:00.000Z'),
        clockMs: (() => {
          const values = [10, 15]
          return () => values.shift() ?? 15
        })(),
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'c1', name: 'echo', args: { value: null } }, makeCtx())

    assert.equal(writes.length, 1)
    const entry = JSON.parse(writes[0]!)
    assert.equal(entry.ok, false)
    assert.deepEqual(entry.argsSummary, {})
    assert.equal(entry.error, 'blocked')
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

  test('strips null values for optional schema fields before zod validation', async () => {
    let received: unknown
    const echo: Tool<{
      target: { type: 'group'; groupId: number; mentionUserId?: number }
      text?: string
      params?: Record<string, string | null>
    }> = {
      name: 'echo',
      description: 'echo input',
      schema: z.object({
        target: z.object({
          type: z.literal('group'),
          groupId: z.number(),
          mentionUserId: z.number().optional(),
        }),
        text: z.string().optional(),
        params: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
      }),
      async execute(args) {
        received = args
        return { content: 'ok' }
      },
    }
    const exec = createToolExecutor([echo])

    const result = await exec.execute(
      {
        id: 'call_1',
        name: 'echo',
        args: {
          target: { type: 'group', groupId: 123, mentionUserId: null },
          text: null,
          params: { nullableDbParam: null },
        },
      },
      makeCtx(),
    )

    assert.equal(result.content, 'ok')
    assert.deepEqual(received, {
      target: { type: 'group', groupId: 123 },
      params: { nullableDbParam: null },
    })
  })
})
