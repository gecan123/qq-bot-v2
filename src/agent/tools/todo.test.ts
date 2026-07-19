import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import { createTodoTool } from './todo.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

describe('todo tool', () => {
  test('update stores a complete ordered todo list and list returns it', async () => {
    const tool = createTodoTool()

    const updated = JSON.parse((await tool.execute({
      action: 'update',
      items: [
        { id: 'read', text: '读现有工具结构', status: 'completed' },
        { id: 'impl', text: '实现最小 todo 工具', status: 'in_progress' },
        { id: 'verify', text: '跑 focused tests', status: 'pending' },
      ],
    }, makeCtx())).content as string) as {
      ok: boolean
      items: { id: string; text: string; status: string }[]
      activeItem?: { id: string }
    }
    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      ok: boolean
      items: { id: string; text: string; status: string }[]
      activeItem?: { id: string }
    }

    assert.equal(updated.ok, true)
    assert.equal(updated.items.length, 3)
    assert.equal(updated.activeItem?.id, 'impl')
    assert.deepEqual(listed.items, updated.items)
  })

  test('update rejects multiple in_progress items and preserves the previous list', async () => {
    const tool = createTodoTool()

    await tool.execute({
      action: 'update',
      items: [{ id: 'one', text: '第一件事', status: 'pending' }],
    }, makeCtx())
    const rejected = JSON.parse((await tool.execute({
      action: 'update',
      items: [
        { id: 'a', text: 'A', status: 'in_progress' },
        { id: 'b', text: 'B', status: 'in_progress' },
      ],
    }, makeCtx())).content as string) as { ok: boolean; error?: string }
    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      items: { id: string }[]
    }

    assert.equal(rejected.ok, false)
    assert.match(rejected.error ?? '', /Only one todo item can be in_progress/)
    assert.deepEqual(listed.items.map((item) => item.id), ['one'])
  })

  test('repeated empty update is an explicit no-progress wait state', async () => {
    const tool = createTodoTool()

    const first = await tool.execute({ action: 'update', items: [] }, makeCtx())
    const result = JSON.parse(first.content as string) as {
      status: string
      changed: boolean
      next: string
    }

    assert.equal(result.status, 'unchanged')
    assert.equal(result.changed, false)
    assert.match(result.next, /without calling todo again/)
    assert.deepEqual(first.outcome, {
      ok: true,
      code: 'unchanged',
      progress: false,
      continuation: 'wait_attention',
      noveltyKey: 'todo:0',
    })
  })

  test('clearing a non-empty list reports progress once', async () => {
    const tool = createTodoTool()
    await tool.execute({
      action: 'update',
      items: [{ id: 'done', text: '完成已有工作', status: 'completed' }],
    }, makeCtx())

    const cleared = await tool.execute({ action: 'update', items: [] }, makeCtx())
    const result = JSON.parse(cleared.content as string) as { status: string; changed: boolean }

    assert.equal(result.status, 'cleared')
    assert.equal(result.changed, true)
    assert.deepEqual(cleared.outcome, {
      ok: true,
      code: 'cleared',
      progress: true,
      continuation: 'immediate',
      noveltyKey: 'todo:2',
    })
  })
})
