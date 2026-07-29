import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { jobQueue } from '../queue/index.js'
import type { JobPriority } from '../queue/types.js'
import { requestJson } from './http.js'

const log = createLogger('MEDIA_CLIENT')

export function requestMediaDescription(
  mediaId: number,
  options: { wait?: boolean; timeoutMs?: number; priority?: JobPriority } = {},
): Promise<void> {
  if (!config.services.enabled) {
    const priority = options.priority ?? (options.wait ? 'high' : 'low')
    if (options.wait) {
      return jobQueue.enqueueAndWait('generate-description', { mediaId }, { priority, maxAttempts: 1 })
    }
    jobQueue.enqueue('generate-description', { mediaId }, { priority, maxAttempts: 1 })
    return Promise.resolve()
  }

  const request = requestJson<{ ok: boolean }>({
    baseUrl: config.services.mediaWorkerUrl,
    path: '/describe',
    method: 'POST',
    body: { mediaId, wait: options.wait === true },
    timeoutMs: options.timeoutMs ?? (options.wait ? 120_000 : 5_000),
  }).then(() => undefined)

  if (options.wait) return request
  void request.catch((error) => log.warn({ error, mediaId }, 'media_worker_enqueue_failed'))
  return Promise.resolve()
}
