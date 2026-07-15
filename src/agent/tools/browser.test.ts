import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createBrowserTool } from './browser.js'
import { BrowserControllerClient } from '../../browser/client.js'
import type { BrowserActionJsonResult } from '../../browser/protocol.js'

describe('browser tool', () => {
  it('returns plain JSON text for ordinary actions', async () => {
    const tool = createBrowserTool({
      client: {
        async action() {
          return { ok: true, action: 'status', message: 'ready' }
        },
      },
    })
    const result = await tool.execute({ action: 'status' }, { eventQueue: null as never, roundIndex: 1 })
    assert.equal(typeof result.content, 'string')
    assert.match(result.content as string, /"message":"ready"/)
  })

  it('keeps oversized observe results valid JSON while dropping tail elements', async () => {
    const elements = Array.from({ length: 80 }, (_, index) => ({
      elementId: `el_${index + 1}`,
      role: 'link',
      label: `result ${index + 1} ${'x'.repeat(120)}`,
      tagName: 'a',
      href: `https://example.com/${index + 1}/${'y'.repeat(160)}`,
      visible: true,
    }))
    const tool = createBrowserTool({
      client: {
        async action() {
          return { ok: true, action: 'observe', pageId: 'page_1', elements }
        },
      },
    })

    const result = await tool.execute({ action: 'observe' }, { eventQueue: null as never, roundIndex: 1 })
    assert.equal(typeof result.content, 'string')
    const parsed = JSON.parse(result.content as string) as {
      truncated?: boolean
      omittedElements?: number
      elements?: unknown[]
    }
    assert.equal(parsed.truncated, true)
    assert.ok((parsed.omittedElements ?? 0) > 0)
    assert.ok((parsed.elements?.length ?? 0) < elements.length)
    assert.ok((result.content as string).length <= 6_000)
  })

  it('keeps screenshot image blocks in tool content', async () => {
    const tool = createBrowserTool({
      client: {
        async action() {
          return {
            ok: true,
            action: 'screenshot',
            image: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
          }
        },
      },
    })
    const result = await tool.execute({ action: 'screenshot' }, { eventQueue: null as never, roundIndex: 1 })
    assert.ok(Array.isArray(result.content))
    assert.equal(result.content[1]?.type, 'image')
  })
})

describe('BrowserControllerClient', () => {
  it('calls a local HTTP controller', async () => {
    const response: BrowserActionJsonResult = { ok: true, action: 'status', message: 'ready' }
    const server = createServer((req, res) => {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/action')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    try {
      const client = new BrowserControllerClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1_000 })
      assert.deepEqual(await client.action({ action: 'status' }), response)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
