import type { Server } from 'node:http'
import { config } from '../config/index.js'
import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import { generateDescriptionForMedia } from '../jobs/generate-description.js'
import { buildMediaProvider } from '../llm/media-provider.js'
import { setLlmProvider } from '../llm/provider.js'
import { createLogger } from '../logger.js'
import { closeServer, startJsonServer, writeJson } from './http.js'

const log = createLogger('MEDIA_WORKER')
const retryAfter = new Map<number, number>()
let server: Server | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let stopping = false
let polling = false

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
        return { ok: true, polling }
      }
      if (request.method === 'POST' && url.pathname === '/describe') {
        const { mediaId, wait } = readDescriptionRequest(body)
        const generation = generateDescriptionForMedia(mediaId).then(() => {
          retryAfter.delete(mediaId)
        })
        if (wait) {
          await generation
        } else {
          void generation.catch((error) => {
            retryAfter.set(mediaId, Date.now() + 60_000)
            log.warn({ error, mediaId }, 'media_description_request_failed')
          })
        }
        return { ok: true, mediaId, accepted: !wait }
      }
      writeJson(response, 404, { ok: false, error: 'not found' })
    },
  })
  schedulePoll(0)
  log.info({ url: config.services.mediaWorkerUrl }, 'media_worker_started')
}

async function poll(): Promise<void> {
  if (stopping || polling) return
  polling = true
  try {
    const rows = await prisma.media.findMany({
      where: {
        descriptionRaw: { equals: Prisma.AnyNull },
        mediaType: { in: ['image', 'sticker', 'video', 'record', 'file'] },
      },
      orderBy: { mediaId: 'asc' },
      take: 20,
      select: { mediaId: true, data: true },
    })
    const now = Date.now()
    for (const row of rows) {
      if (stopping) break
      if (row.data.byteLength === 0 || (retryAfter.get(row.mediaId) ?? 0) > now) continue
      try {
        await generateDescriptionForMedia(row.mediaId)
        retryAfter.set(row.mediaId, now + 5 * 60_000)
      } catch (error) {
        retryAfter.set(row.mediaId, now + 60_000)
        log.warn({ error, mediaId: row.mediaId }, 'media_description_attempt_failed')
      }
    }
  } finally {
    polling = false
    schedulePoll(config.services.mediaPollMs)
  }
}

function schedulePoll(delayMs: number): void {
  if (stopping) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void poll(), delayMs)
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'media_worker_shutdown_requested')
  if (timer) clearTimeout(timer)
  if (server) await closeServer(server).catch((error) => log.warn({ error }, 'media_worker_server_close_failed'))
  await prisma.$disconnect()
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
