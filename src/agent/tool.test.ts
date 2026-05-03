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
    assert.match(result.content, /Unknown tool/)
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
    assert.match(result.content, /Invalid tool arguments/)
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
    assert.match(result.content, /Tool execution failed: kaboom/)
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
