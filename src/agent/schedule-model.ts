import { Cron } from 'croner'
import { z } from 'zod'

export const SCHEDULE_LIMITS = {
  minAtDelayMs: 30_000,
  maxLifetimeMs: 3 * 24 * 60 * 60 * 1_000,
  minRecurringIntervalMs: 5 * 60 * 1_000,
  maxActiveSchedules: 20,
} as const

export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Shanghai'

const MAX_DATE_TIMESTAMP_MS = 8.64e15
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i

export type ScheduleSpec =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everySeconds: number; anchorAt: string }
  | { kind: 'cron'; expression: string; timezone: string }

export type ScheduleErrorCode =
  | 'invalid_schedule'
  | 'outside_schedule_window'
  | 'recurrence_too_frequent'

export class ScheduleModelError extends Error {
  readonly code: ScheduleErrorCode

  constructor(code: ScheduleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduleModelError'
    this.code = code
  }
}

const atAbsoluteInputSchema = z
  .object({
    kind: z.literal('at'),
    at: z.string().min(1),
  })
  .strict()

const atRelativeInputSchema = z
  .object({
    kind: z.literal('at'),
    afterSeconds: z.number().finite().positive(),
  })
  .strict()

const everyInputSchema = z
  .object({
    kind: z.literal('every'),
    everySeconds: z.number().finite().positive(),
    anchorAt: z.string().min(1).optional(),
  })
  .strict()

const cronInputSchema = z
  .object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
  })
  .strict()

const scheduleInputSchema = z.union([
  atAbsoluteInputSchema,
  atRelativeInputSchema,
  everyInputSchema,
  cronInputSchema,
])

export function normalizeScheduleSpec(input: unknown, now: Date): ScheduleSpec {
  assertValidDate(now, 'now')

  const parsed = scheduleInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new ScheduleModelError('invalid_schedule', 'Schedule input is invalid', {
      cause: parsed.error,
    })
  }

  if (parsed.data.kind === 'at') {
    const at = 'at' in parsed.data
      ? parseDate(parsed.data.at, 'at')
      : resolveRelativeAt(parsed.data.afterSeconds, now)
    assertWithinAtWindow(at, now)
    return { kind: 'at', at: at.toISOString() }
  }

  if (parsed.data.kind === 'every') {
    const intervalMs = recurringIntervalMs(parsed.data.everySeconds)
    if (intervalMs < SCHEDULE_LIMITS.minRecurringIntervalMs) {
      throw new ScheduleModelError(
        'recurrence_too_frequent',
        'Recurring schedules must be at least five minutes apart',
      )
    }
    const anchorAt = parsed.data.anchorAt
      ? parseDate(parsed.data.anchorAt, 'anchorAt')
      : new Date(now)
    return {
      kind: 'every',
      everySeconds: parsed.data.everySeconds,
      anchorAt: anchorAt.toISOString(),
    }
  }

  const schedule: ScheduleSpec = {
    kind: 'cron',
    expression: parsed.data.expression,
    timezone: parsed.data.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
  }
  validateCronSchedule(schedule, now)
  return schedule
}

export function computeNextRunAt(schedule: ScheduleSpec, after: Date): Date | null {
  assertValidDate(after, 'after')

  if (schedule.kind === 'at') {
    const at = parseDate(schedule.at, 'at')
    return at.getTime() > after.getTime() ? at : null
  }

  if (schedule.kind === 'every') {
    const anchorAt = parseDate(schedule.anchorAt, 'anchorAt')
    if (anchorAt.getTime() > after.getTime()) return anchorAt

    const intervalMs = recurringIntervalMs(schedule.everySeconds)
    const elapsedMs = after.getTime() - anchorAt.getTime()
    const nextTimestampMs =
      anchorAt.getTime() + (Math.floor(elapsedMs / intervalMs) + 1) * intervalMs
    return dateFromTimestamp(nextTimestampMs, 'next run')
  }

  const next = withCron(schedule, (cron) => cron.nextRun(after))
  if (next) assertValidDate(next, 'next run')
  return next
}

function assertWithinAtWindow(at: Date, now: Date): void {
  const delayMs = at.getTime() - now.getTime()
  if (
    !Number.isFinite(delayMs) ||
    delayMs < SCHEDULE_LIMITS.minAtDelayMs ||
    delayMs > SCHEDULE_LIMITS.maxLifetimeMs
  ) {
    throw new ScheduleModelError(
      'outside_schedule_window',
      'One-shot schedules must run between 30 seconds and three days from now',
    )
  }
}

function validateCronSchedule(schedule: Extract<ScheduleSpec, { kind: 'cron' }>, now: Date): void {
  withCron(schedule, (cron) => {
    const horizon = now.getTime() + SCHEDULE_LIMITS.maxLifetimeMs
    let previous = cron.nextRun(now)
    if (!previous || previous.getTime() > horizon) {
      throw new ScheduleModelError(
        'outside_schedule_window',
        'Cron schedule has no trigger within the next three days',
      )
    }

    while (true) {
      const next = cron.nextRun(previous)
      if (!next) return
      const intervalMs = next.getTime() - previous.getTime()
      if (intervalMs <= 0) {
        throw new ScheduleModelError('invalid_schedule', 'Cron schedule did not advance')
      }
      if (intervalMs < SCHEDULE_LIMITS.minRecurringIntervalMs) {
        throw new ScheduleModelError(
          'recurrence_too_frequent',
          'Cron schedules must be at least five minutes apart',
        )
      }
      if (next.getTime() > horizon) return
      previous = next
    }
  })
}

function withCron<T>(
  schedule: Extract<ScheduleSpec, { kind: 'cron' }>,
  action: (cron: Cron) => T,
): T {
  let cron: Cron
  try {
    cron = new Cron(schedule.expression, {
      paused: true,
      timezone: schedule.timezone,
    })
  } catch (error) {
    throw new ScheduleModelError('invalid_schedule', 'Cron expression or timezone is invalid', {
      cause: error,
    })
  }

  try {
    return action(cron)
  } catch (error) {
    if (error instanceof ScheduleModelError) throw error
    throw new ScheduleModelError('invalid_schedule', 'Cron schedule could not be evaluated', {
      cause: error,
    })
  } finally {
    cron.stop()
  }
}

function parseDate(value: string, field: string): Date {
  const match = ISO_TIMESTAMP_PATTERN.exec(value)
  if (!match) {
    throw new ScheduleModelError(
      'invalid_schedule',
      `${field} must be an ISO timestamp with an explicit timezone offset`,
    )
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ScheduleModelError('invalid_schedule', `${field} is not a real calendar time`)
  }

  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new ScheduleModelError('invalid_schedule', `${field} must be a valid timestamp`)
  }
  return date
}

function resolveRelativeAt(afterSeconds: number, now: Date): Date {
  const delayMs = afterSeconds * 1_000
  if (
    !Number.isFinite(delayMs) ||
    delayMs < SCHEDULE_LIMITS.minAtDelayMs ||
    delayMs > SCHEDULE_LIMITS.maxLifetimeMs
  ) {
    throw new ScheduleModelError(
      'outside_schedule_window',
      'One-shot schedules must run between 30 seconds and three days from now',
    )
  }
  return dateFromTimestamp(now.getTime() + delayMs, 'at')
}

function recurringIntervalMs(everySeconds: number): number {
  const intervalMs = everySeconds * 1_000
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > MAX_DATE_TIMESTAMP_MS
  ) {
    throw new ScheduleModelError(
      'invalid_schedule',
      'Recurring interval exceeds the representable Date range',
    )
  }
  return intervalMs
}

function dateFromTimestamp(timestampMs: number, field: string): Date {
  if (!Number.isFinite(timestampMs) || Math.abs(timestampMs) > MAX_DATE_TIMESTAMP_MS) {
    throw new ScheduleModelError('invalid_schedule', `${field} exceeds the representable Date range`)
  }
  const date = new Date(timestampMs)
  assertValidDate(date, field)
  return date
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function assertValidDate(date: Date, field: string): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new ScheduleModelError('invalid_schedule', `${field} must be a valid Date`)
  }
}
