import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createBackgroundTaskTool } from './background-task.js'
import { createTradingAgentTool } from './trading-agent.js'

const runtimeConfig = {
  baseUrl: 'http://127.0.0.1:8899',
  apiKey: 'test-secret',
  requestTimeoutMs: 1_000,
  taskTimeoutMs: 10_000,
  pollIntervalMs: 1,
  resultMaxChars: 200,
}

describe('trading_agent', () => {
  test('starts a bounded research-only background task and exposes its result', async () => {
    const registry = createInMemoryTaskRegistry()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const requests: { url: string; init?: RequestInit }[] = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      requests.push({ url, init })
      const path = new URL(url).pathname
      if (path === '/sessions' && init?.method === 'POST') {
        return jsonResponse({ session_id: 'session-1' }, 201)
      }
      if (path === '/sessions/session-1/messages' && init?.method === 'POST') {
        return jsonResponse({ message_id: 'message-1', attempt_id: 'attempt-1' })
      }
      if (path === '/sessions/session-1') {
        return jsonResponse({ session_id: 'session-1', last_attempt_id: 'attempt-1' })
      }
      if (path === '/sessions/session-1/messages') {
        return jsonResponse([
          {
            role: 'assistant',
            content: '研究结果正文',
            linked_attempt_id: 'attempt-1',
            metadata: { status: 'completed', run_id: 'run-1', metrics: { sharpe: 1.2 } },
          },
        ])
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }
    const tool = createTradingAgentTool({
      taskRegistry: registry,
      runtimeConfig,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
    })
    assert.match(tool.description, /具体金融问题.*跨来源取证.*历史回测/)
    assert.match(tool.description, /简单价格数据优先用 openbb_cli/)

    const started = JSON.parse((await tool.execute({
      action: 'start',
      prompt: '回测 BTC 均线策略',
    }, { eventQueue, roundIndex: 1 })).content as string) as {
      taskId: string
      sessionId: string
      attemptId: string
    }

    assert.equal(started.sessionId, 'session-1')
    assert.equal(started.attemptId, 'attempt-1')
    await waitUntil(() => registry.get(started.taskId)?.status === 'completed')

    const post = requests.find((request) => (
      new URL(request.url).pathname === '/sessions/session-1/messages'
      && request.init?.method === 'POST'
    ))
    assert.ok(post)
    const body = JSON.parse(String(post.init?.body)) as { content: string }
    assert.match(body.content, /不得执行真实下单/)
    assert.match(body.content, /回测 BTC 均线策略/)
    assert.equal(new Headers(post.init?.headers).get('Authorization'), 'Bearer test-secret')

    const backgroundTask = createBackgroundTaskTool({ taskRegistry: registry })
    const detail = await backgroundTask.execute({ action: 'get', taskId: started.taskId }, { eventQueue, roundIndex: 1 })
    assert.match(JSON.stringify(detail.content), /研究结果正文/)
    assert.match(JSON.stringify(detail.content), /session-1/)
    assert.match(JSON.stringify(detail.content), /run-1/)

    const completion = await eventQueue.dequeue()
    assert.ok(completion)
    if (!completion || completion.type !== 'background_task_completed') {
      throw new Error('expected background_task_completed event')
    }
    assert.equal(completion.toolName, 'trading_agent')
    assert.equal(completion.ok, true)
  })

  test('recovers a persisted result directly by session id', async () => {
    const tool = createTradingAgentTool({
      taskRegistry: createInMemoryTaskRegistry(),
      runtimeConfig: { ...runtimeConfig, resultMaxChars: 8 },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input))
        if (url.pathname === '/sessions/session-2') {
          return jsonResponse({ session_id: 'session-2', last_attempt_id: 'attempt-2' })
        }
        return jsonResponse([
          {
            role: 'assistant',
            content: '1234567890',
            linked_attempt_id: 'attempt-2',
            metadata: { status: 'completed' },
          },
        ])
      }) as typeof fetch,
    })

    const result = JSON.parse((await tool.execute({
      action: 'result',
      sessionId: 'session-2',
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })).content as string) as {
      status: string
      result: string
      truncated: boolean
      attemptId: string
    }

    assert.equal(result.status, 'completed')
    assert.equal(result.attemptId, 'attempt-2')
    assert.equal(result.result, '12345...')
    assert.equal(result.truncated, true)
  })

  test('rejects non-success API responses without leaking unbounded bodies', async () => {
    const tool = createTradingAgentTool({
      taskRegistry: createInMemoryTaskRegistry(),
      runtimeConfig,
      fetchImpl: (async () => new Response('x'.repeat(2_000), { status: 401 })) as typeof fetch,
    })

    await assert.rejects(
      tool.execute({ action: 'start', prompt: '研究 AAPL' }, {
        eventQueue: new InMemoryEventQueue<BotEvent>(),
        roundIndex: 1,
      }),
      (err: unknown) => err instanceof Error && err.message.length < 1_000 && /HTTP 401/.test(err.message),
    )
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('timed out waiting for task')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
