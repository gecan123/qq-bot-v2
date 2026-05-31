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
