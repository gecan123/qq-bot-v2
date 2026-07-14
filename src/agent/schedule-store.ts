import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  computeNextRunAt,
  normalizeScheduleSpec,
  ScheduleModelError,
  SCHEDULE_LIMITS,
  type ScheduleSpec,
} from './schedule-model.js'

export interface ScheduleJob {
  id: string
  name: string
  intention: string
  schedule: ScheduleSpec
  createdAt: string
  expiresAt: string
  nextRunAt: string
  lastRunAt?: string
  runCount: number
  maxRuns?: number
}

export interface ScheduleStore {
  load(): Promise<ScheduleJob[]>
  replace(schedules: readonly ScheduleJob[]): Promise<void>
}

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'String must contain non-whitespace characters',
})
const isoTimestampSchema = z.iso.datetime({ offset: true })

const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: isoTimestampSchema }).strict(),
  z
    .object({
      kind: z.literal('every'),
      everySeconds: z.number().finite().positive(),
      anchorAt: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cron'),
      expression: nonBlankStringSchema,
      timezone: nonBlankStringSchema,
    })
    .strict(),
])

const scheduleJobSchema = z
  .object({
    id: nonBlankStringSchema,
    name: nonBlankStringSchema,
    intention: nonBlankStringSchema,
    schedule: scheduleSpecSchema,
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    nextRunAt: isoTimestampSchema,
    lastRunAt: isoTimestampSchema.optional(),
    runCount: z.number().int().nonnegative(),
    maxRuns: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((job, context) => {
    const createdAt = Date.parse(job.createdAt)
    const expiresAt = Date.parse(job.expiresAt)
    const nextRunAt = Date.parse(job.nextRunAt)

    if (expiresAt !== createdAt + SCHEDULE_LIMITS.maxLifetimeMs) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must equal createdAt plus the maximum schedule lifetime',
      })
    }
    if (nextRunAt < createdAt || nextRunAt > expiresAt) {
      context.addIssue({
        code: 'custom',
        path: ['nextRunAt'],
        message: 'nextRunAt must be between createdAt and expiresAt',
      })
    }
    if (job.lastRunAt !== undefined) {
      const lastRunAt = Date.parse(job.lastRunAt)
      if (lastRunAt < createdAt || lastRunAt > nextRunAt) {
        context.addIssue({
          code: 'custom',
          path: ['lastRunAt'],
          message: 'lastRunAt must be between createdAt and nextRunAt',
        })
      }
    }

    if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
      context.addIssue({
        code: 'custom',
        path: ['maxRuns'],
        message: 'An active schedule must have remaining runs',
      })
    }

    try {
      const normalizedSchedule = normalizeScheduleSpec(job.schedule, new Date(job.createdAt))
      const expectedNextRunAt = normalizedSchedule.kind === 'at'
        ? new Date(normalizedSchedule.at)
        : computeNextRunAt(
            normalizedSchedule,
            new Date(job.lastRunAt ?? job.createdAt),
          )
      if (expectedNextRunAt?.getTime() !== nextRunAt) {
        context.addIssue({
          code: 'custom',
          path: ['nextRunAt'],
          message: 'nextRunAt must match the next trigger derived from the schedule',
        })
      }
    } catch (error) {
      if (!(error instanceof ScheduleModelError)) throw error
      context.addIssue({
        code: 'custom',
        path: ['schedule'],
        message: `${error.code}: ${error.message}`,
      })
    }
  })

const schedulesSchema = z.array(scheduleJobSchema).max(SCHEDULE_LIMITS.maxActiveSchedules)
const storedSchedulesSchema = z
  .object({
    version: z.literal(1),
    schedules: schedulesSchema,
  })
  .strict()

export function createInMemoryScheduleStore(
  initialSchedules: readonly ScheduleJob[] = [],
): ScheduleStore {
  let schedules = parseSchedules(initialSchedules)

  return {
    async load() {
      return cloneSchedules(schedules)
    },

    async replace(nextSchedules) {
      schedules = parseSchedules(nextSchedules)
    },
  }
}

export function createPersistentScheduleStore(path: string): ScheduleStore {
  return {
    async load() {
      let contents: string
      try {
        contents = await readFile(path, 'utf8')
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return []
        throw error
      }

      const stored = storedSchedulesSchema.parse(JSON.parse(contents) as unknown)
      return cloneSchedules(stored.schedules)
    },

    async replace(nextSchedules) {
      const schedules = parseSchedules(nextSchedules)
      const directory = dirname(path)
      await mkdir(directory, { recursive: true })
      const temporaryPath = join(
        directory,
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
      )

      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 1, schedules }, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx' },
        )
        await rename(temporaryPath, path)
      } finally {
        try {
          await rm(temporaryPath, { force: true })
        } catch {
          // Best-effort cleanup must not hide the write or rename failure.
        }
      }
    },
  }
}

function parseSchedules(schedules: readonly ScheduleJob[]): ScheduleJob[] {
  return cloneSchedules(schedulesSchema.parse(schedules))
}

function cloneSchedules(schedules: readonly ScheduleJob[]): ScheduleJob[] {
  return structuredClone(schedules) as ScheduleJob[]
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
