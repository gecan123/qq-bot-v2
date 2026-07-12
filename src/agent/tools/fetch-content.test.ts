import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createFetchContentTool } from './fetch-content.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { Tool, ToolContext, ToolExecutionResult } from '../tool.js'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { createTaskScheduler } from '../task-scheduler.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

function delegateTool(name: string, calls: unknown[], content: ToolExecutionResult['content'] = `${name} result`): Tool {
  return {
    name,
    description: `${name} delegate`,
    schema: z.any(),
    async execute(args) {
      calls.push(args)
      return { content }
    },
  }
}

describe('fetch_content tool', () => {
  test('action=url background mode returns immediately and publishes a completed task result', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const urlCalls: unknown[] = []
    const taskRegistry = createInMemoryTaskRegistry()
    const taskScheduler = createTaskScheduler({ network: { concurrency: 1 } })
    const urlTool: Tool = {
      name: 'fetch_url',
      description: 'fetch delegate',
      schema: z.any(),
      async execute(args) {
        urlCalls.push(args)
        await gate
        return { content: JSON.stringify({ ok: true, summary: 'done' }) }
      },
    }
    const ctx = makeCtx()
    const tool = createFetchContentTool({ urlTool, taskRegistry, taskScheduler })

    const started = await tool.execute({
      action: 'url',
      url: 'https://example.com/slow',
      background: true,
    }, ctx)
    const payload = JSON.parse(started.content as string) as { taskId: string; status: string }

    assert.equal(payload.status, 'started')
    assert.equal(taskRegistry.get(payload.taskId)?.status, 'running')
    assert.deepEqual(urlCalls, [{ url: 'https://example.com/slow' }])

    release()
    await taskScheduler.drain()
    assert.equal(taskRegistry.get(payload.taskId)?.status, 'completed')
    assert.equal(ctx.eventQueue.dequeue()?.type, 'background_task_completed')
  })

  test('action=url delegates to fetch_url with url and hint', async () => {
    const urlCalls: unknown[] = []
    const imageCalls: unknown[] = []
    const tool = createFetchContentTool({
      urlTool: delegateTool('fetch_url', urlCalls),
      imageTool: delegateTool('fetch_image', imageCalls),
    })

    const result = await tool.execute({
      action: 'url',
      url: 'https://example.com/article',
      hint: 'core point',
    }, makeCtx())

    assert.equal(result.content, 'fetch_url result')
    assert.deepEqual(urlCalls, [{ url: 'https://example.com/article', hint: 'core point' }])
    assert.deepEqual(imageCalls, [])
  })

  test('action=image_url delegates to fetch_image action=url', async () => {
    const urlCalls: unknown[] = []
    const imageCalls: unknown[] = []
    const tool = createFetchContentTool({
      urlTool: delegateTool('fetch_url', urlCalls),
      imageTool: delegateTool('fetch_image', imageCalls),
    })

    const result = await tool.execute({
      action: 'image_url',
      url: 'https://example.com/cat.png',
    }, makeCtx())

    assert.equal(result.content, 'fetch_image result')
    assert.deepEqual(urlCalls, [])
    assert.deepEqual(imageCalls, [{ action: 'url', url: 'https://example.com/cat.png' }])
  })

  test('action=qq_avatar delegates to fetch_image action=qq_avatar', async () => {
    const urlCalls: unknown[] = []
    const imageCalls: unknown[] = []
    const tool = createFetchContentTool({
      urlTool: delegateTool('fetch_url', urlCalls),
      imageTool: delegateTool('fetch_image', imageCalls),
    })

    const result = await tool.execute({
      action: 'qq_avatar',
      qq: 123456,
      size: '100',
    }, makeCtx())

    assert.equal(result.content, 'fetch_image result')
    assert.deepEqual(urlCalls, [])
    assert.deepEqual(imageCalls, [{ action: 'qq_avatar', qq: 123456, size: '100' }])
  })

  test('action=reddit_list delegates to reddit action=list', async () => {
    const urlCalls: unknown[] = []
    const imageCalls: unknown[] = []
    const redditCalls: unknown[] = []
    const tool = createFetchContentTool({
      urlTool: delegateTool('fetch_url', urlCalls),
      imageTool: delegateTool('fetch_image', imageCalls),
      redditTool: delegateTool('reddit', redditCalls),
    })

    const result = await tool.execute({
      action: 'reddit_list',
      subreddit: 'technology',
      sort: 'hot',
      limit: 5,
    }, makeCtx())

    assert.equal(result.content, 'reddit result')
    assert.deepEqual(urlCalls, [])
    assert.deepEqual(imageCalls, [])
    assert.deepEqual(redditCalls, [{ action: 'list', subreddit: 'technology', sort: 'hot', limit: 5 }])
  })

  test('action=reddit_post delegates to reddit action=get_post', async () => {
    const urlCalls: unknown[] = []
    const imageCalls: unknown[] = []
    const redditCalls: unknown[] = []
    const tool = createFetchContentTool({
      urlTool: delegateTool('fetch_url', urlCalls),
      imageTool: delegateTool('fetch_image', imageCalls),
      redditTool: delegateTool('reddit', redditCalls),
    })

    const result = await tool.execute({
      action: 'reddit_post',
      url: 'https://www.reddit.com/r/technology/comments/abc/story/',
    }, makeCtx())

    assert.equal(result.content, 'reddit result')
    assert.deepEqual(urlCalls, [])
    assert.deepEqual(imageCalls, [])
    assert.deepEqual(redditCalls, [{
      action: 'get_post',
      url: 'https://www.reddit.com/r/technology/comments/abc/story/',
    }])
  })
})
