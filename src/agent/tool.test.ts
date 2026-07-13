import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createDeferredToolExecutor, createToolExecutor, type Tool } from './tool.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createAgentContext } from './agent-context.js'

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
    assert.equal(entry.ts, '2026-05-25T20:00:00.000+08:00')
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

  test('supports thin side-effect-only audit and fully disabled audit modes', async () => {
    const writes: string[] = []
    const read: Tool<Record<string, never>> = {
      name: 'skill',
      description: 'read',
      schema: z.object({}),
      async execute() { return { content: '{"ok":true}' } },
    }
    const send: Tool<Record<string, never>> = {
      name: 'send_message',
      description: 'send',
      schema: z.object({}),
      async execute() { return { content: '{"ok":true}' } },
    }
    const thin = createToolExecutor([read, send], {
      trace: {
        mode: 'side_effects',
        appender: async (_path, line) => { writes.push(line) },
      },
    })
    await thin.execute({ id: 'read', name: 'skill', args: {} }, makeCtx())
    await thin.execute({ id: 'send', name: 'send_message', args: {} }, makeCtx())
    assert.deepEqual(writes.map((line) => JSON.parse(line).toolName), ['send_message'])

    const off = createToolExecutor([send], {
      trace: {
        mode: 'off',
        appender: async (_path, line) => { writes.push(line) },
      },
    })
    await off.execute({ id: 'off', name: 'send_message', args: {} }, makeCtx())
    assert.equal(writes.length, 1)
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
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.retryable, true)
    assert.match(payload.hint, /inc 的当前 schema.*修正参数.*立即重试同一工具/)
    assert.match(payload.hint, /不要改用相似但不存在的工具/)
    assert.equal(writes.length, 1)
    const entry = JSON.parse(writes[0]!.trim())
    assert.equal(entry.toolName, 'inc')
    assert.equal(entry.roundIndex, 8)
    assert.equal(entry.durationMs, 3)
    assert.equal(entry.ok, false)
    assert.equal(entry.sideEffect, false)
    assert.equal(entry.error, 'Invalid tool arguments')
  })

  test('prefers explicit outcome metadata when classifying traces', async () => {
    const writes: string[] = []
    const tool: Tool<Record<string, never>> = {
      name: 'external_fetch',
      description: 'fetch',
      schema: z.object({}),
      async execute() {
        return {
          content: 'ordinary prose that does not encode an error',
          outcome: { ok: false, code: 'network_error', error: 'request failed' },
        }
      },
    }
    const exec = createToolExecutor([tool], {
      trace: {
        now: () => new Date('2026-07-06T00:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    const result = await exec.execute({ id: 'fetch-1', name: 'external_fetch', args: {} }, makeCtx())

    assert.deepEqual(result.outcome, { ok: false, code: 'network_error', error: 'request failed' })
    assert.equal(JSON.parse(writes[0]!).ok, false)
    assert.equal(JSON.parse(writes[0]!).error, 'request failed')
  })

  test('classifies merged memory side effects by action', async () => {
    const writes: string[] = []
    const memory: Tool<{ action: 'write' | 'search' | 'list' | 'delete' | 'update_entry' | 'delete_entry' | 'promote_entry' | 'compact' }> = {
      name: 'memory',
      description: 'memory',
      schema: z.object({ action: z.enum(['write', 'search', 'list', 'delete', 'update_entry', 'delete_entry', 'promote_entry', 'compact']) }),
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
    await exec.execute({ id: 'list', name: 'memory', args: { action: 'list' } }, makeCtx())
    await exec.execute({ id: 'delete', name: 'memory', args: { action: 'delete' } }, makeCtx())
    await exec.execute({ id: 'update', name: 'memory', args: { action: 'update_entry' } }, makeCtx())
    await exec.execute({ id: 'delete-entry', name: 'memory', args: { action: 'delete_entry' } }, makeCtx())
    await exec.execute({ id: 'promote-entry', name: 'memory', args: { action: 'promote_entry' } }, makeCtx())
    await exec.execute({ id: 'compact', name: 'memory', args: { action: 'compact' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, true)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, false)
    assert.equal(JSON.parse(writes[3]!).sideEffect, true)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
    assert.equal(JSON.parse(writes[5]!).sideEffect, true)
    assert.equal(JSON.parse(writes[6]!).sideEffect, true)
    assert.equal(JSON.parse(writes[7]!).sideEffect, true)
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

  test('classifies website mutation and publish actions as side effects', async () => {
    const writes: string[] = []
    const website: Tool<{ action: 'status' | 'read' | 'write' | 'delete' | 'move' | 'publish' }> = {
      name: 'website',
      description: 'website',
      schema: z.object({ action: z.enum(['status', 'read', 'write', 'delete', 'move', 'publish']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([website], {
      trace: {
        now: () => new Date('2026-07-10T00:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'status', name: 'website', args: { action: 'status' } }, makeCtx())
    await exec.execute({ id: 'read', name: 'website', args: { action: 'read' } }, makeCtx())
    await exec.execute({ id: 'write', name: 'website', args: { action: 'write' } }, makeCtx())
    await exec.execute({ id: 'delete', name: 'website', args: { action: 'delete' } }, makeCtx())
    await exec.execute({ id: 'move', name: 'website', args: { action: 'move' } }, makeCtx())
    await exec.execute({ id: 'publish', name: 'website', args: { action: 'publish' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, false)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, true)
    assert.equal(JSON.parse(writes[3]!).sideEffect, true)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
    assert.equal(JSON.parse(writes[5]!).sideEffect, true)
  })

  test('classifies workspace_file and collect_sticker mutations as side effects', async () => {
    const writes: string[] = []
    const workspaceFile: Tool<{ action: 'list' | 'read' | 'write' | 'replace' | 'delete' | 'move' }> = {
      name: 'workspace_file',
      description: 'workspace file',
      schema: z.object({ action: z.enum(['list', 'read', 'write', 'replace', 'delete', 'move']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const collectSticker: Tool<{ action: 'list' | 'collect' | 'remove' }> = {
      name: 'collect_sticker',
      description: 'collect sticker',
      schema: z.object({ action: z.enum(['list', 'collect', 'remove']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([workspaceFile, collectSticker], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    for (const action of ['list', 'read', 'write', 'replace', 'delete', 'move'] as const) {
      await exec.execute({ id: `workspace-${action}`, name: 'workspace_file', args: { action } }, makeCtx())
    }
    for (const action of ['list', 'collect', 'remove'] as const) {
      await exec.execute({ id: `sticker-${action}`, name: 'collect_sticker', args: { action } }, makeCtx())
    }

    assert.deepEqual(writes.map((line) => JSON.parse(line).sideEffect), [
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
    ])
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
    await exec.execute({ id: 'redirect', name: 'workspace_bash', args: { command: 'printf hi > notes/today.md' } }, makeCtx())
    await exec.execute({ id: 'fetch-url', name: 'workspace_bash', args: { command: 'fetch url https://example.com' } }, makeCtx())
    await exec.execute({ id: 'fetch-image', name: 'workspace_bash', args: { command: 'fetch image https://example.com/cat.png' } }, makeCtx())
    await exec.execute({ id: 'unknown', name: 'workspace_bash', args: { command: 'curl https://example.com' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, false)
    assert.equal(JSON.parse(writes[1]!).sideEffect, true)
    assert.equal(JSON.parse(writes[2]!).sideEffect, false)
    assert.equal(JSON.parse(writes[3]!).sideEffect, true)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
  })

  test('classifies notebook mutations as side effects', async () => {
    const writes: string[] = []
    const notebook: Tool<{ action: 'write' | 'list' | 'search' | 'read' | 'update' | 'delete' | 'compact' }> = {
      name: 'notebook',
      description: 'notebook',
      schema: z.object({ action: z.enum(['write', 'list', 'search', 'read', 'update', 'delete', 'compact']) }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([notebook], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'write', name: 'notebook', args: { action: 'write' } }, makeCtx())
    await exec.execute({ id: 'list', name: 'notebook', args: { action: 'list' } }, makeCtx())
    await exec.execute({ id: 'search', name: 'notebook', args: { action: 'search' } }, makeCtx())
    await exec.execute({ id: 'read', name: 'notebook', args: { action: 'read' } }, makeCtx())
    await exec.execute({ id: 'update', name: 'notebook', args: { action: 'update' } }, makeCtx())
    await exec.execute({ id: 'delete', name: 'notebook', args: { action: 'delete' } }, makeCtx())
    await exec.execute({ id: 'compact', name: 'notebook', args: { action: 'compact' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, true)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, false)
    assert.equal(JSON.parse(writes[3]!).sideEffect, false)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
    assert.equal(JSON.parse(writes[5]!).sideEffect, true)
    assert.equal(JSON.parse(writes[6]!).sideEffect, true)
  })

  test('classifies life_journal mutation actions as side effects', async () => {
    const writes: string[] = []
    const lifeJournal: Tool<{ action: 'write' | 'read_recent' | 'read_agenda' | 'update' | 'delete' | 'compact' | 'write_agenda' }> = {
      name: 'life_journal',
      description: 'life journal',
      schema: z.object({
        action: z.enum(['write', 'read_recent', 'read_agenda', 'update', 'delete', 'compact', 'write_agenda']),
      }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([lifeJournal], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'write', name: 'life_journal', args: { action: 'write' } }, makeCtx())
    await exec.execute({ id: 'recent', name: 'life_journal', args: { action: 'read_recent' } }, makeCtx())
    await exec.execute({ id: 'read-agenda', name: 'life_journal', args: { action: 'read_agenda' } }, makeCtx())
    await exec.execute({ id: 'update', name: 'life_journal', args: { action: 'update' } }, makeCtx())
    await exec.execute({ id: 'delete', name: 'life_journal', args: { action: 'delete' } }, makeCtx())
    await exec.execute({ id: 'compact', name: 'life_journal', args: { action: 'compact' } }, makeCtx())
    await exec.execute({ id: 'write-agenda', name: 'life_journal', args: { action: 'write_agenda' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, true)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, false)
    assert.equal(JSON.parse(writes[3]!).sideEffect, true)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
    assert.equal(JSON.parse(writes[5]!).sideEffect, true)
    assert.equal(JSON.parse(writes[6]!).sideEffect, true)
  })

  test('classifies skill_editor write actions as side effects', async () => {
    const writes: string[] = []
    const skillEditor: Tool<{ action: 'draft' | 'validate' | 'install' | 'list_drafts' | 'read_draft' | 'delete_draft' }> = {
      name: 'skill_editor',
      description: 'skill editor',
      schema: z.object({
        action: z.enum(['draft', 'validate', 'install', 'list_drafts', 'read_draft', 'delete_draft']),
      }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createToolExecutor([skillEditor], {
      trace: {
        now: () => new Date('2026-05-25T12:00:00.000Z'),
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute({ id: 'draft', name: 'skill_editor', args: { action: 'draft' } }, makeCtx())
    await exec.execute({ id: 'validate', name: 'skill_editor', args: { action: 'validate' } }, makeCtx())
    await exec.execute({ id: 'install', name: 'skill_editor', args: { action: 'install' } }, makeCtx())
    await exec.execute({ id: 'list', name: 'skill_editor', args: { action: 'list_drafts' } }, makeCtx())
    await exec.execute({ id: 'delete', name: 'skill_editor', args: { action: 'delete_draft' } }, makeCtx())

    assert.equal(JSON.parse(writes[0]!).sideEffect, true)
    assert.equal(JSON.parse(writes[1]!).sideEffect, false)
    assert.equal(JSON.parse(writes[2]!).sideEffect, true)
    assert.equal(JSON.parse(writes[3]!).sideEffect, false)
    assert.equal(JSON.parse(writes[4]!).sideEffect, true)
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
    const workspaceBash: Tool<Record<string, never>> = {
      name: 'workspace_bash',
      description: 'workspace bash',
      schema: z.object({}),
      async execute() {
        return { content: 'unused' }
      },
    }
    const exec = createToolExecutor([workspaceBash])
    const result = await exec.execute({ id: 'c1', name: 'nope', args: {} }, makeCtx())
    assert.match(result.content as string, /Unknown tool/)
    const payload = JSON.parse(result.content as string)
    assert.deepEqual(payload.availableTools, ['workspace_bash'])
    assert.equal(payload.retryable, true)
    assert.match(payload.hint, /availableTools.*help describe\/activate/)
    assert.deepEqual(result.outcome, { ok: false, code: 'unknown_tool', error: 'Unknown tool: nope' })
  })

  test('returns targeted recovery hints for removed tool names', async () => {
    const exec = createToolExecutor([])
    const sendImage = JSON.parse((await exec.execute({ id: 'c1', name: 'send_image', args: {} }, makeCtx())).content as string)
    const workspaceCommand = JSON.parse((await exec.execute({ id: 'c2', name: 'workspace_command', args: {} }, makeCtx())).content as string)

    assert.match(sendImage.hint, /send_message.*imageRef/)
    assert.match(workspaceCommand.hint, /workspace_bash.*cwd.*command/)
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
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'invalid_arguments')
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
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'execution_failed',
      error: 'Tool execution failed: kaboom',
    })
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

describe('createDeferredToolExecutor', () => {
  test('traces an active deferred invocation once as the target tool', async () => {
    const writes: string[] = []
    const browser: Tool<{ action: 'status' }> = {
      name: 'browser',
      description: 'browser',
      schema: z.object({ action: z.literal('status') }),
      async execute() {
        return { content: JSON.stringify({ ok: true }) }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [],
      activeCapabilities: {
        list: () => ['browser'],
        activate() {},
        deactivate() {},
      },
      capabilities: [{ name: 'browser', description: 'browser', tools: [browser] }],
      trace: {
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute(
      { id: 'invoke-browser', name: 'invoke', args: { tool: 'browser', args: { action: 'status' } } },
      makeCtx(),
    )

    assert.equal(writes.length, 1)
    const trace = JSON.parse(writes[0]!)
    assert.equal(trace.toolCallId, 'invoke-browser')
    assert.equal(trace.toolName, 'browser')
    assert.equal(trace.ok, true)
    assert.deepEqual(trace.argsSummary, { action: 'status' })
  })

  test('traces rejected deferred invocations once as failed invoke calls', async () => {
    const writes: string[] = []
    const browser: Tool<Record<string, never>> = {
      name: 'browser',
      description: 'browser',
      schema: z.object({}),
      async execute() {
        return { content: 'browser-ok' }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [],
      capabilities: [{ name: 'browser', description: 'browser', tools: [browser] }],
      trace: {
        clockMs: () => 100,
        appender: async (_path, line) => {
          writes.push(line)
        },
      },
    })

    await exec.execute(
      { id: 'inactive', name: 'invoke', args: { tool: 'browser', args: {} } },
      makeCtx(),
    )
    await exec.execute(
      { id: 'unknown', name: 'invoke', args: { tool: 'missing', args: {} } },
      makeCtx(),
    )

    assert.equal(writes.length, 2)
    assert.deepEqual(
      writes.map((line) => {
        const trace = JSON.parse(line)
        return { id: trace.toolCallId, toolName: trace.toolName, ok: trace.ok }
      }),
      [
        { id: 'inactive', toolName: 'invoke', ok: false },
        { id: 'unknown', toolName: 'invoke', ok: false },
      ],
    )
  })

  test('keeps deferred tools behind stable help and invoke tools', async () => {
    const echo: Tool<{ text: string }> = {
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
      async execute(args) {
        return { content: args.text }
      },
    }
    const browser: Tool<{ action: 'status' }> = {
      name: 'browser',
      description: 'browser',
      schema: z.object({ action: z.literal('status') }),
      async execute() {
        return { content: JSON.stringify({ ok: true, action: 'status' }) }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [echo],
      capabilities: [
        {
          name: 'browser',
          description: '真实浏览器操作',
          tools: [browser],
        },
      ],
    })

    assert.deepEqual(exec.list().map((tool) => tool.name), ['echo', 'help', 'invoke'])
    assert.match(
      (await exec.execute({ id: 'b0', name: 'browser', args: { action: 'status' } }, makeCtx())).content as string,
      /Unknown tool/,
    )
    assert.match(
      (
        await exec.execute(
          { id: 'i0', name: 'invoke', args: { tool: 'browser', args: { action: 'status' } } },
          makeCtx(),
        )
      ).content as string,
      /capability_inactive/,
    )

    const activated = await exec.execute(
      { id: 'a1', name: 'help', args: { action: 'activate', capability: 'browser' } },
      makeCtx(),
    )

    assert.match(activated.content as string, /invoke/)
    assert.deepEqual(exec.list().map((tool) => tool.name), ['echo', 'help', 'invoke'])
    assert.match(
      (
        await exec.execute(
          { id: 'i1', name: 'invoke', args: { tool: 'browser', args: { action: 'status' } } },
          makeCtx(),
        )
      ).content as string,
      /"ok":true/,
    )
    assert.match(
      (
        await exec.execute(
          { id: 'i2', name: 'invoke', args: { tool: 'browser', args: '{"action":"status"}', action: 'status' } },
          makeCtx(),
        )
      ).content as string,
      /"ok":true/,
    )
  })

  test('returns a concrete read then replace hint for invalid workspace_file arguments', async () => {
    const workspaceFile: Tool<{ action: 'read'; file: string }> = {
      name: 'workspace_file',
      description: 'workspace file',
      schema: z.object({ action: z.literal('read'), file: z.string().min(1) }),
      async execute() {
        return { content: 'workspace-ok' }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [],
      activeCapabilities: {
        list: () => ['workspace_management'],
        activate() {},
        deactivate() {},
      },
      capabilities: [{ name: 'workspace_management', description: 'workspace', tools: [workspaceFile] }],
    })

    const result = JSON.parse(
      (await exec.execute(
        { id: 'workspace-invalid', name: 'invoke', args: { tool: 'workspace_file', args: {} } },
        makeCtx(),
      )).content as string,
    ) as { ok: boolean; hint: string }

    assert.equal(result.ok, false)
    assert.match(result.hint, /action":"read/)
    assert.match(result.hint, /action":"replace/)
    assert.match(result.hint, /expectedRevision/)
  })

  test('can store active capabilities in an external runtime state', async () => {
    const active: string[] = ['browser']
    const browser: Tool<Record<string, never>> = {
      name: 'browser',
      description: 'browser',
      schema: z.object({}),
      async execute() {
        return { content: 'browser-ok' }
      },
    }
    const media: Tool<Record<string, never>> = {
      name: 'generate_image',
      description: 'image',
      schema: z.object({}),
      async execute() {
        return { content: 'image-ok' }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [],
      activeCapabilities: {
        list: () => [...active],
        activate: (capability) => {
          if (!active.includes(capability)) active.push(capability)
        },
        deactivate: (capability) => {
          const index = active.indexOf(capability)
          if (index >= 0) active.splice(index, 1)
        },
      },
      capabilities: [
        { name: 'browser', description: 'browser', tools: [browser] },
        { name: 'media_generation', description: 'image', tools: [media] },
      ],
    })

    assert.deepEqual(exec.list().map((tool) => tool.name), ['help', 'invoke'])
    assert.match(
      (
        await exec.execute(
          { id: 'b1', name: 'invoke', args: { tool: 'browser', args: {} } },
          makeCtx(),
        )
      ).content as string,
      /browser-ok/,
    )

    await exec.execute(
      { id: 'a1', name: 'help', args: { action: 'activate', capability: 'media_generation' } },
      makeCtx(),
    )
    assert.deepEqual(active, ['browser', 'media_generation'])
    assert.deepEqual(exec.list().map((tool) => tool.name), ['help', 'invoke'])
    assert.match(
      (
        await exec.execute(
          { id: 'm1', name: 'invoke', args: { tool: 'generate_image', args: {} } },
          makeCtx(),
        )
      ).content as string,
      /image-ok/,
    )

    await exec.execute(
      { id: 'd1', name: 'help', args: { action: 'deactivate', capability: 'browser' } },
      makeCtx(),
    )
    assert.deepEqual(active, ['media_generation'])
    assert.deepEqual(exec.list().map((tool) => tool.name), ['help', 'invoke'])
    assert.match(
      (
        await exec.execute(
          { id: 'b2', name: 'invoke', args: { tool: 'browser', args: {} } },
          makeCtx(),
        )
      ).content as string,
      /capability_inactive/,
    )
  })

  test('restored AgentContext state controls invoke access without changing the top-level tool list', async () => {
    const browser: Tool<Record<string, never>> = {
      name: 'browser',
      description: 'browser',
      schema: z.object({}),
      async execute() {
        return { content: 'browser-ok' }
      },
    }
    const ctx1 = createAgentContext()
    const exec1 = createDeferredToolExecutor({
      alwaysOnTools: [],
      activeCapabilities: {
        list: () => ctx1.getSnapshot().activeToolCapabilities,
        activate: (capability) => ctx1.activateToolCapability(capability),
        deactivate: (capability) => ctx1.deactivateToolCapability(capability),
      },
      capabilities: [{ name: 'browser', description: 'browser', tools: [browser] }],
    })

    await exec1.execute(
      { id: 'a1', name: 'help', args: { action: 'activate', capability: 'browser' } },
      makeCtx(),
    )
    const persisted = ctx1.exportPersistedSnapshot()

    const ctx2 = createAgentContext()
    ctx2.restorePersistedSnapshot(persisted)
    const exec2 = createDeferredToolExecutor({
      alwaysOnTools: [],
      activeCapabilities: {
        list: () => ctx2.getSnapshot().activeToolCapabilities,
        activate: (capability) => ctx2.activateToolCapability(capability),
        deactivate: (capability) => ctx2.deactivateToolCapability(capability),
      },
      capabilities: [{ name: 'browser', description: 'browser', tools: [browser] }],
    })

    assert.deepEqual(ctx2.getSnapshot().activeToolCapabilities, ['browser'])
    assert.deepEqual(exec2.list().map((tool) => tool.name), ['help', 'invoke'])
    assert.match(
      (
        await exec2.execute(
          { id: 'b1', name: 'invoke', args: { tool: 'browser', args: {} } },
          makeCtx(),
        )
      ).content as string,
      /browser-ok/,
    )
  })

  test('help describes deferred tool schemas on demand', async () => {
    const browser: Tool<{ action: 'status' }> = {
      name: 'browser',
      description: 'browser status',
      schema: z.object({ action: z.literal('status').describe('状态检查') }),
      async execute() {
        return { content: 'browser-ok' }
      },
    }
    const exec = createDeferredToolExecutor({
      alwaysOnTools: [],
      capabilities: [{ name: 'browser', description: 'browser capability', tools: [browser] }],
    })

    const described = JSON.parse(
      (await exec.execute({ id: 'h1', name: 'help', args: { action: 'describe', tool: 'browser' } }, makeCtx()))
        .content as string,
    ) as {
      ok: boolean
      tool: { name: string; capability: string; active: boolean; inputSchema: { properties?: Record<string, unknown> } }
    }

    assert.equal(described.ok, true)
    assert.equal(described.tool.name, 'browser')
    assert.equal(described.tool.capability, 'browser')
    assert.equal(described.tool.active, false)
    assert.ok(described.tool.inputSchema.properties?.action)
  })
})
