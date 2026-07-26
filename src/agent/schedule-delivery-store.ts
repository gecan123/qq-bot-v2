import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { SCHEDULE_LIMITS } from './schedule-model.js'
import type { ScheduleOccurrence } from './schedule-occurrence-store.js'

export interface ScheduleDeliveryStore {
  recordPending(occurrence: ScheduleOccurrence): Promise<void>
  loadPending(): Promise<ScheduleOccurrence[]>
  complete(scheduleId: string): Promise<void>
}

const MAX_PENDING_DELIVERIES = 200
const occurrenceSchema = z.object({
  scheduleId: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength),
  intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength),
  scheduledFor: z.iso.datetime({ offset: true }),
}).strict()
const storedSchema = z.object({
  version: z.literal(1),
  pending: z.array(occurrenceSchema).max(MAX_PENDING_DELIVERIES),
}).strict()

export function createPersistentScheduleDeliveryStore(path: string): ScheduleDeliveryStore {
  let mutationTail: Promise<void> = Promise.resolve()
  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return await result
  }

  return {
    async recordPending(raw) {
      await mutate(async () => {
        const occurrence = occurrenceSchema.parse(raw)
        const current = await loadPending(path)
        const existing = current.find((item) => item.scheduleId === occurrence.scheduleId)
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(occurrence)) {
            throw new Error(`schedule delivery conflict: ${occurrence.scheduleId}`)
          }
          return
        }
        await persistPending(path, [...current, occurrence])
      })
    },

    async loadPending() {
      await mutationTail
      return structuredClone(await loadPending(path)) as ScheduleOccurrence[]
    },

    async complete(scheduleId) {
      await mutate(async () => {
        const current = await loadPending(path)
        const next = current.filter((item) => item.scheduleId !== scheduleId)
        if (next.length !== current.length) await persistPending(path, next)
      })
    },
  }
}

async function loadPending(path: string): Promise<ScheduleOccurrence[]> {
  try {
    const stored = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    return structuredClone(stored.pending) as ScheduleOccurrence[]
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

async function persistPending(path: string, pending: readonly ScheduleOccurrence[]): Promise<void> {
  const parsed = z.array(occurrenceSchema).max(MAX_PENDING_DELIVERIES).parse(pending)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, pending: parsed }, null, 2)}\n`,
      'utf8',
    )
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
