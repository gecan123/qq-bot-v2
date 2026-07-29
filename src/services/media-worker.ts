import type { Server } from 'node:http'
import { config } from '../config/index.js'
import { prisma } from '../database/client.js'
import { generateDescriptionForMedia } from '../jobs/generate-description.js'
import { buildMediaProvider } from '../llm/media-provider.js'
import { setLlmProvider } from '../llm/provider.js'
import { createLogger } from '../logger.js'
import { closeServer, startJsonServer, writeJson } from './http.js'

const log = createLogger('MEDIA_WORKER')
const activeGenerations = new Set<Promise<void>>()
let server: Server | null = null
let stopping = false

async function main(): Promise<void> {
  await prisma.$connect()
  setLlmProvider(buildMediaProvider(
    config.llm,
    config.services.enabled ? { gatewayUrl: config.services.llmGatewayUrl } : {},
  ))
  server = await startJsonServer({
    baseUrl: config.services.mediaWorkerUrl,
    async handler({ request, response, url, body }) {
      if (request.method === 'GET' && url.pathname === '/health') {
        return { ok: true, activeGenerations: activeGenerations.size }
      }
      if (request.method === 'POST' && url.pathname === '/describe') {
        const { mediaId, wait } = readDescriptionRequest(body)
        const generation = trackGeneration(mediaId)
        if (wait) {
          await generation
        } else {
          void generation.catch((error) => {
            log.warn({ error, mediaId }, 'media_description_request_failed')
          })
        }
        return { ok: true, mediaId, accepted: !wait }
      }
      writeJson(response, 404, { ok: false, error: 'not found' })
    },
  })
  log.info({ url: config.services.mediaWorkerUrl }, 'media_worker_started')
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'media_worker_shutdown_requested')
  const closePromise = server
    ? closeServer(server).catch((error) => log.warn({ error }, 'media_worker_server_close_failed'))
    : Promise.resolve()
  const drained = await drainActiveWork(8_000)
  if (!drained) {
    log.warn({
      activeGenerations: activeGenerations.size,
    }, 'media_worker_drain_timed_out')
    server?.closeAllConnections()
  }
  await closePromise
  await prisma.$disconnect()
}

function trackGeneration(mediaId: number): Promise<void> {
  const generation = generateDescriptionForMedia(mediaId)
  activeGenerations.add(generation)
  void generation.then(
    () => activeGenerations.delete(generation),
    () => activeGenerations.delete(generation),
  )
  return generation
}

async function drainActiveWork(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (activeGenerations.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    const completed = await Promise.race([
      Promise.allSettled([...activeGenerations]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remainingMs)),
    ])
    if (!completed) return false
  }
  return true
}

function readDescriptionRequest(body: unknown): { mediaId: number; wait: boolean } {
  const mediaId = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).mediaId
    : undefined
  if (typeof mediaId !== 'number' || !Number.isSafeInteger(mediaId) || mediaId <= 0) {
    throw new Error('mediaId must be a positive safe integer')
  }
  const wait = (body as Record<string, unknown>).wait
  if (wait !== undefined && typeof wait !== 'boolean') throw new Error('wait must be a boolean')
  return { mediaId, wait: wait === true }
}

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)))

void main().catch(async (error) => {
  log.fatal({ error }, 'media_worker_start_failed')
  await shutdown('startup_failure')
  process.exitCode = 1
})
