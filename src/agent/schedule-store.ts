import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { parseStoredScheduleAt, SCHEDULE_LIMITS } from './schedule-model.js'

export interface ScheduleJob {
  id: string
  name: string
  intention: string
  at: string
  createdAt: string
}

export interface ScheduleStore {
  load(): Promise<ScheduleJob[]>
  replace(schedules: readonly ScheduleJob[]): Promise<void>
}

const timestampSchema = z.iso.datetime({ offset: true })
const scheduleJobSchema = z.object({
  id: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength),
  intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength),
  at: timestampSchema,
  createdAt: timestampSchema,
}).strict().superRefine((job, context) => {
  try {
    const at = Date.parse(parseStoredScheduleAt(job.at))
    const createdAt = Date.parse(job.createdAt)
    const delayMs = at - createdAt
    if (delayMs < SCHEDULE_LIMITS.minAtDelayMs || delayMs > SCHEDULE_LIMITS.maxLifetimeMs) {
      context.addIssue({
        code: 'custom',
        path: ['at'],
        message: 'at must be 30 seconds to three days after createdAt',
      })
    }
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['at'], message: String(error) })
  }
})

const schedulesSchema = z.array(scheduleJobSchema)
  .max(SCHEDULE_LIMITS.maxActiveSchedules)
  .superRefine((schedules, context) => {
    const ids = new Set<string>()
    const names = new Set<string>()
    schedules.forEach((schedule, index) => {
      if (ids.has(schedule.id)) {
        context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Schedule ids must be unique' })
      }
      if (names.has(schedule.name)) {
        context.addIssue({ code: 'custom', path: [index, 'name'], message: 'Schedule names must be unique' })
      }
      ids.add(schedule.id)
      names.add(schedule.name)
    })
  })

const storedSchema = z.object({
  version: z.literal(2),
  schedules: schedulesSchema,
}).strict()

export function validateScheduleJobs(input: readonly ScheduleJob[]): ScheduleJob[] {
  return structuredClone(schedulesSchema.parse(input)) as ScheduleJob[]
}

export function createInMemoryScheduleStore(initial: readonly ScheduleJob[] = []): ScheduleStore {
  let schedules = validateScheduleJobs(initial)
  return {
    async load() {
      return structuredClone(schedules) as ScheduleJob[]
    },
    async replace(next) {
      schedules = validateScheduleJobs(next)
    },
  }
}

export function createPersistentScheduleStore(path: string): ScheduleStore {
  return {
    async load() {
      try {
        const stored = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
        return validateScheduleJobs(stored.schedules)
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return []
        throw error
      }
    },
    async replace(next) {
      const schedules = validateScheduleJobs(next)
      const directory = dirname(path)
      await mkdir(directory, { recursive: true })
      const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 2, schedules }, null, 2)}\n`,
          'utf8',
        )
        await rename(temporaryPath, path)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
