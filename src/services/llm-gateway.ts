import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { closeServer } from './http.js'

const log = createLogger('LLM_GATEWAY')
const gatewayUrl = new URL(config.services.llmGatewayUrl)
const port = Number(gatewayUrl.port)
let server: Server | null = null
let stopping = false

async function main(): Promise<void> {
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`BOT_LLM_GATEWAY_URL must include a valid port: ${config.services.llmGatewayUrl}`)
  }
  server = createServer(async (request, response) => {
    const startedAt = Date.now()
    try {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, providers: Object.keys(config.llm.providers).sort() }))
        return
      }
      const route = resolveRoute(request.url ?? '/')
      if (!route) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'provider route not found' }))
        return
      }

      const body = await readBody(request, 100 * 1024 * 1024)
      const headers = forwardHeaders(request.headers)
      headers.set('authorization', `Bearer ${route.provider.apiKey}`)
      headers.set('x-api-key', route.provider.apiKey)
      const upstream = await fetch(route.url, {
        method: request.method ?? 'POST',
        headers,
        body: body.byteLength > 0 ? body as unknown as BodyInit : undefined,
        signal: AbortSignal.timeout(10 * 60_000),
      })

      response.statusCode = upstream.status
      for (const [name, value] of upstream.headers) {
        if (isHopByHopHeader(name)) continue
        response.setHeader(name, value)
      }
      const bytes = Buffer.from(await upstream.arrayBuffer())
      response.setHeader('content-length', bytes.byteLength)
      response.end(bytes)
      log.info({
        provider: route.providerName,
        method: request.method,
        path: route.path,
        status: upstream.status,
        requestBytes: body.byteLength,
        responseBytes: bytes.byteLength,
        durationMs: Date.now() - startedAt,
      }, 'llm_gateway_request_completed')
    } catch (error) {
      log.error({ error, path: request.url, durationMs: Date.now() - startedAt }, 'llm_gateway_request_failed')
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      }
      response.end(JSON.stringify({ error: { message: 'LLM gateway upstream request failed' } }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(port, gatewayUrl.hostname || '127.0.0.1', () => {
      server!.off('error', reject)
      resolve()
    })
  })
  log.info({ url: config.services.llmGatewayUrl }, 'llm_gateway_started')
}

function resolveRoute(rawUrl: string): {
  providerName: string
  provider: { url: string; apiKey: string }
  path: string
  url: URL
} | null {
  const url = new URL(rawUrl, config.services.llmGatewayUrl)
  const match = /^\/provider\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!match) return null
  const providerName = decodeURIComponent(match[1]!)
  const provider = config.llm.providers[providerName]
  if (!provider) return null
  const path = (match[2] ?? '/').replace(/^\/+/, '')
  const base = provider.url.endsWith('/') ? provider.url : `${provider.url}/`
  const target = new URL(path, base)
  target.search = url.search
  return { providerName, provider, path, url: target }
}

function forwardHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || isHopByHopHeader(name) || name.toLowerCase() === 'host') continue
    output.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return output
}

function isHopByHopHeader(name: string): boolean {
  return ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']
    .includes(name.toLowerCase())
}

async function readBody(request: AsyncIterable<unknown>, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.byteLength
    if (total > limitBytes) throw new Error(`LLM request exceeds ${limitBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'llm_gateway_shutdown_requested')
  if (server) await closeServer(server)
}

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)))

void main().catch(async (error) => {
  log.fatal({ error }, 'llm_gateway_start_failed')
  await shutdown('startup_failure').catch(() => undefined)
  process.exitCode = 1
})
