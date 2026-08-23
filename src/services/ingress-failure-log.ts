import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readBoundedTextTail } from '../ops/bounded-text-tail.js'

export const INGRESS_FAILURE_LOG_PATH = 'logs/ingress-failures.ndjson'
const INGRESS_FAILURE_TAIL_MAX_BYTES = 512 * 1024

const ingressFailureSchema = z.object({
  schemaVersion: z.literal(1),
  failedAt: z.iso.datetime({ offset: true }),
  platform: z.enum(['qq', 'feishu']),
  kind: z.string().min(1).max(80),
  errorKind: z.string().min(1).max(120),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict()

export type IngressFailure = z.infer<typeof ingressFailureSchema>

export interface RecentIngressFailures {
  status: 'available' | 'missing' | 'invalid'
  count: number
  truncated: boolean
  invalidLines: number
  lastFailedAt: string | null
  lastErrorKind: string | null
}

export async function recordIngressFailure(input: {
  platform: 'qq' | 'feishu'
  kind: string
  error: unknown
  context?: IngressFailure['context']
  path?: string
  now?: Date
}): Promise<void> {
  const path = input.path ?? INGRESS_FAILURE_LOG_PATH
  const record = ingressFailureSchema.parse({
    schemaVersion: 1,
    failedAt: (input.now ?? new Date()).toISOString(),
    platform: input.platform,
    kind: input.kind,
    errorKind: classifyError(input.error),
    context: input.context ?? {},
  })
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export async function readRecentIngressFailures(input: {
  path?: string
  now?: Date
  windowMs?: number
  maxBytes?: number
} = {}): Promise<RecentIngressFailures> {
  const path = input.path ?? INGRESS_FAILURE_LOG_PATH
  const threshold = (input.now ?? new Date()).getTime() - (input.windowMs ?? 24 * 60 * 60_000)
  try {
    const tail = await readBoundedTextTail(path, input.maxBytes ?? INGRESS_FAILURE_TAIL_MAX_BYTES)
    const records: IngressFailure[] = []
    let invalidLines = 0
    for (const rawLine of tail.content.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      try {
        const parsed = ingressFailureSchema.safeParse(JSON.parse(line))
        if (!parsed.success) {
          invalidLines++
          continue
        }
        if (Date.parse(parsed.data.failedAt) >= threshold) records.push(parsed.data)
      } catch {
        invalidLines++
      }
    }
    const last = records.at(-1)
    return {
      status: 'available',
      count: records.length,
      truncated: tail.truncated,
      invalidLines,
      lastFailedAt: last?.failedAt ?? null,
      lastErrorKind: last?.errorKind ?? null,
    }
  } catch (error) {
    return {
      status: isNodeError(error) && error.code === 'ENOENT' ? 'missing' : 'invalid',
      count: 0,
      truncated: false,
      invalidLines: 0,
      lastFailedAt: null,
      lastErrorKind: null,
    }
  }
}

function classifyError(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.slice(0, 120)
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.slice(0, 120)
  }
  return typeof error
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
