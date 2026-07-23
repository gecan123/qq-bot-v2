import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  type WorkspaceCommandRunner,
  workspaceCommandInputSchema,
} from './protocol.js'

export interface WorkspaceExecutorServerOptions {
  host: string
  port: number
  runner: WorkspaceCommandRunner
  token?: string
}

export async function startWorkspaceExecutorServer(
  options: WorkspaceExecutorServerOptions,
): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || req.url !== '/run') {
        writeJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        writeJson(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      const parsed = workspaceCommandInputSchema.safeParse(JSON.parse(await readBody(req)))
      if (!parsed.success) {
        writeJson(res, 400, { ok: false, error: 'invalid workspace command request' })
        return
      }
      const result = await options.runner(parsed.data)
      writeJson(res, result.ok ? 200 : result.code === 'command_not_allowed' ? 400 : 500, result)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
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
      if (body.length > 32_000) req.destroy(new Error('request too large'))
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
