import http from 'node:http'
import { URL } from 'node:url'
import { createLogger } from '../logger.js'

export type RouteHandler = (
  params: Record<string, string>,
  body: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<unknown>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

const routes: Route[] = []
const log = createLogger('HTTP')

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = []
  const regexStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
}

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function startHttpServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    for (const route of routes) {
      if (route.method !== (req.method ?? '').toUpperCase()) continue
      const match = url.pathname.match(route.pattern)
      if (!match) continue

      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? '')
      })

      try {
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '')
        const body = hasBody ? await parseBody(req) : {}
        const result = await route.handler(params, body, req, res)
        if (!res.headersSent) {
          json(res, 200, result)
        }
      } catch (err) {
        log.error({ path: url.pathname, error: err }, 'http_api_error')
        if (!res.headersSent) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      }
      return
    }

    json(res, 404, { error: 'Not found' })
  })

  server.listen(port, () => {
    log.info({ port }, 'HTTP API server started')
  })

  return server
}
