import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BrowserController } from './controller.js'

export interface BrowserServerOptions {
  host: string
  port: number
  controller: BrowserController
}

export async function startBrowserServer(options: BrowserServerOptions): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || req.url !== '/action') {
        writeJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      const body = await readBody(req)
      const input = body.length > 0 ? JSON.parse(body) : {}
      const result = await options.controller.execute(input)
      writeJson(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeJson(res, 500, { ok: false, error: message })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 1_000_000) {
        req.destroy(new Error('request too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
