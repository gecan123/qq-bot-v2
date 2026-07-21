import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { SCHEDULE_LIMITS } from './schedule-model.js'

export interface ScheduleOccurrence {
  scheduleId: string
  name: string
  intention: string
  scheduleKind: 'at' | 'every' | 'cron'
  scheduledFor: string
  runCount: number
}

export interface ScheduleOccurrenceStore {
  record(occurrence: ScheduleOccurrence): Promise<void>
  get(scheduleId: string, runCount: number): Promise<ScheduleOccurrence | null>
}

const MAX_OCCURRENCES = 200
const isoTimestampSchema = z.iso.datetime({ offset: true })
const occurrenceSchema = z.object({
  scheduleId: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength),
  intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength),
  scheduleKind: z.enum(['at', 'every', 'cron']),
  scheduledFor: isoTimestampSchema,
  runCount: z.number().int().positive(),
}).strict()
const storedSchema = z.object({
  version: z.literal(1),
  occurrences: z.array(occurrenceSchema).max(MAX_OCCURRENCES),
}).strict()

export function createInMemoryScheduleOccurrenceStore(
  initialOccurrences: readonly ScheduleOccurrence[] = [],
): ScheduleOccurrenceStore {
  let occurrences = parseOccurrences(initialOccurrences)
  return {
    async record(occurrence) {
      occurrences = recordOccurrence(occurrences, occurrence)
    },
    async get(scheduleId, runCount) {
      return cloneOccurrence(findOccurrence(occurrences, scheduleId, runCount))
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
        if (next === current) return
        await persistOccurrences(path, next)
      })
    },
    async get(scheduleId, runCount) {
      await mutationTail
      return cloneOccurrence(findOccurrence(await loadOccurrences(path), scheduleId, runCount))
    },
  }
}

function recordOccurrence(
  current: readonly ScheduleOccurrence[],
  rawOccurrence: ScheduleOccurrence,
): ScheduleOccurrence[] {
  const occurrence = occurrenceSchema.parse(rawOccurrence)
  const existing = findOccurrence(current, occurrence.scheduleId, occurrence.runCount)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(occurrence)) {
      throw new Error(`schedule occurrence conflict: ${occurrence.scheduleId}:${occurrence.runCount}`)
    }
    return current as ScheduleOccurrence[]
  }
  return parseOccurrences([...current, occurrence].slice(-MAX_OCCURRENCES))
}

function findOccurrence(
  occurrences: readonly ScheduleOccurrence[],
  scheduleId: string,
  runCount: number,
): ScheduleOccurrence | null {
  if (!Number.isSafeInteger(runCount) || runCount <= 0) return null
  return occurrences.find((item) => (
    item.scheduleId === scheduleId && item.runCount === runCount
  )) ?? null
}

function parseOccurrences(input: readonly ScheduleOccurrence[]): ScheduleOccurrence[] {
  const occurrences = z.array(occurrenceSchema).max(MAX_OCCURRENCES).parse(input)
  const keys = new Set<string>()
  for (const occurrence of occurrences) {
    const key = `${occurrence.scheduleId}:${occurrence.runCount}`
    if (keys.has(key)) throw new Error(`duplicate schedule occurrence: ${key}`)
    keys.add(key)
  }
  return structuredClone(occurrences) as ScheduleOccurrence[]
}

async function loadOccurrences(path: string): Promise<ScheduleOccurrence[]> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
  return parseOccurrences(storedSchema.parse(JSON.parse(contents) as unknown).occurrences)
}

async function persistOccurrences(
  path: string,
  occurrences: readonly ScheduleOccurrence[],
): Promise<void> {
  const parsed = parseOccurrences(occurrences)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, occurrences: parsed }, null, 2)}\n`,
      'utf8',
    )
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

function cloneOccurrence(occurrence: ScheduleOccurrence | null): ScheduleOccurrence | null {
  return occurrence == null ? null : structuredClone(occurrence) as ScheduleOccurrence
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
