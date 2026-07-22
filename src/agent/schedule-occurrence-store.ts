import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { SCHEDULE_LIMITS } from './schedule-model.js'

export interface ScheduleOccurrence {
  scheduleId: string
  name: string
  intention: string
  scheduledFor: string
}

export interface ScheduleOccurrenceStore {
  record(occurrence: ScheduleOccurrence): Promise<void>
  get(scheduleId: string): Promise<ScheduleOccurrence | null>
}

const MAX_OCCURRENCES = 200
const occurrenceSchema = z.object({
  scheduleId: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength),
  intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength),
  scheduledFor: z.iso.datetime({ offset: true }),
}).strict()
const storedSchema = z.object({
  version: z.literal(2),
  occurrences: z.array(occurrenceSchema).max(MAX_OCCURRENCES),
}).strict()

export function createInMemoryScheduleOccurrenceStore(
  initial: readonly ScheduleOccurrence[] = [],
): ScheduleOccurrenceStore {
  let occurrences = parseOccurrences(initial)
  return {
    async record(occurrence) {
      occurrences = recordOccurrence(occurrences, occurrence)
    },
    async get(scheduleId) {
      return cloneOccurrence(occurrences.find((item) => item.scheduleId === scheduleId) ?? null)
    },
  }
}

export function createPersistentScheduleOccurrenceStore(path: string): ScheduleOccurrenceStore {
  let mutationTail: Promise<void> = Promise.resolve()
  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return await result
  }
  return {
    async record(occurrence) {
      await mutate(async () => {
        const current = await loadOccurrences(path)
        const next = recordOccurrence(current, occurrence)
        if (next !== current) await persistOccurrences(path, next)
      })
    },
    async get(scheduleId) {
      await mutationTail
      return cloneOccurrence((await loadOccurrences(path)).find(
        (item) => item.scheduleId === scheduleId,
      ) ?? null)
    },
  }
}

function recordOccurrence(
  current: readonly ScheduleOccurrence[],
  raw: ScheduleOccurrence,
): ScheduleOccurrence[] {
  const occurrence = occurrenceSchema.parse(raw)
  const existing = current.find((item) => item.scheduleId === occurrence.scheduleId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(occurrence)) {
      throw new Error(`schedule occurrence conflict: ${occurrence.scheduleId}`)
    }
    return current as ScheduleOccurrence[]
  }
  return parseOccurrences([...current, occurrence].slice(-MAX_OCCURRENCES))
}

function parseOccurrences(input: readonly ScheduleOccurrence[]): ScheduleOccurrence[] {
  const occurrences = z.array(occurrenceSchema).max(MAX_OCCURRENCES).parse(input)
  const ids = new Set<string>()
  for (const occurrence of occurrences) {
    if (ids.has(occurrence.scheduleId)) {
      throw new Error(`duplicate schedule occurrence: ${occurrence.scheduleId}`)
    }
    ids.add(occurrence.scheduleId)
  }
  return structuredClone(occurrences) as ScheduleOccurrence[]
}

async function loadOccurrences(path: string): Promise<ScheduleOccurrence[]> {
  try {
    const stored = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    return parseOccurrences(stored.occurrences)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

async function persistOccurrences(path: string, occurrences: readonly ScheduleOccurrence[]): Promise<void> {
  const parsed = parseOccurrences(occurrences)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 2, occurrences: parsed }, null, 2)}\n`,
      'utf8',
    )
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function cloneOccurrence(value: ScheduleOccurrence | null): ScheduleOccurrence | null {
  return value == null ? null : structuredClone(value) as ScheduleOccurrence
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
