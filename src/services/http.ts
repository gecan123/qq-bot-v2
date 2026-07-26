import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

const DEFAULT_BODY_LIMIT_BYTES = 25 * 1024 * 1024

export interface JsonRequestContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  body: unknown
}

export type JsonRequestHandler = (context: JsonRequestContext) => Promise<unknown> | unknown

export async function startJsonServer(input: {
  baseUrl: string
  handler: JsonRequestHandler
  bodyLimitBytes?: number
}): Promise<Server> {
  const baseUrl = new URL(input.baseUrl)
  const host = baseUrl.hostname || '127.0.0.1'
  const port = Number(baseUrl.port)
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`service URL must include a valid port: ${input.baseUrl}`)
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', input.baseUrl)
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? null
        : await readJsonBody(request, input.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES)
      const result = await input.handler({ request, response, url, body })
      if (!response.headersSent) writeJson(response, 200, result ?? { ok: true })
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

export async function requestJson<T>(input: {
  baseUrl: string
  path: string
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutMs?: number
  fetcher?: typeof fetch
}): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? 15_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetcher = input.fetcher ?? fetch
  try {
    const response = await fetcher(new URL(input.path, ensureTrailingSlash(input.baseUrl)), {
      method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
      headers: input.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = text.length > 0 ? JSON.parse(text) as unknown : null
    if (!response.ok) {
      const detail = parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : text.slice(0, 500)
      throw new Error(`service HTTP ${response.status}: ${detail}`)
    }
    return parsed as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`service request timed out after ${timeoutMs}ms`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`)
    chunks.push(bytes)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
