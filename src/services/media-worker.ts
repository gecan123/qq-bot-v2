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
const activeGenerations = new Set<Promise<void>>()
let server: Server | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let activePoll: Promise<void> | null = null
let stopping = false
let polling = false
let scanAfterMediaId = 0

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
        const generation = trackGeneration(mediaId).then(() => {
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
    const now = Date.now()
    pruneRetryAfter(now)
    let rows = await loadPendingMediaBatch(scanAfterMediaId)
    if (rows.length === 0 && scanAfterMediaId > 0) {
      scanAfterMediaId = 0
      rows = await loadPendingMediaBatch(0)
    }
    if (rows.length > 0) scanAfterMediaId = rows.at(-1)!.mediaId
    for (const row of rows) {
      if (stopping) break
      if (!row.blob || row.blob.byteSize === 0 || (retryAfter.get(row.mediaId) ?? 0) > now) continue
      try {
        await trackGeneration(row.mediaId)
        retryAfter.set(row.mediaId, Date.now() + 5 * 60_000)
      } catch (error) {
        retryAfter.set(row.mediaId, Date.now() + 60_000)
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
  timer = setTimeout(() => {
    timer = null
    const current = poll()
    activePoll = current
    void current.then(
      () => {
        if (activePoll === current) activePoll = null
      },
      (error) => {
        if (activePoll === current) activePoll = null
        log.warn({ error }, 'media_poll_failed')
      },
    )
  }, delayMs)
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'media_worker_shutdown_requested')
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const closePromise = server
    ? closeServer(server).catch((error) => log.warn({ error }, 'media_worker_server_close_failed'))
    : Promise.resolve()
  const drained = await drainActiveWork(8_000)
  if (!drained) {
    log.warn({
      polling: activePoll != null,
      activeGenerations: activeGenerations.size,
    }, 'media_worker_drain_timed_out')
    server?.closeAllConnections()
  }
  await closePromise
  await prisma.$disconnect()
}

function loadPendingMediaBatch(afterMediaId: number) {
  return prisma.media.findMany({
    where: {
      mediaId: { gt: afterMediaId },
      blobId: { not: null },
      descriptionRaw: { equals: Prisma.AnyNull },
      mediaType: { in: ['image', 'sticker', 'video', 'record', 'file'] },
    },
    orderBy: { mediaId: 'asc' },
    take: 20,
    distinct: ['blobId'],
    select: {
      mediaId: true,
      blob: { select: { byteSize: true } },
    },
  })
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

function pruneRetryAfter(now: number): void {
  for (const [mediaId, retryAt] of retryAfter) {
    if (retryAt <= now) retryAfter.delete(mediaId)
  }
}

async function drainActiveWork(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (activePoll || activeGenerations.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    const pending = [
      ...(activePoll ? [activePoll] : []),
      ...activeGenerations,
    ]
    const completed = await Promise.race([
      Promise.allSettled(pending).then(() => true),
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
