import { z } from 'zod'

export const SCHEDULE_LIMITS = {
  minAtDelayMs: 30_000,
  maxLifetimeMs: 3 * 24 * 60 * 60 * 1_000,
  maxActiveSchedules: 20,
  maxIdLength: 200,
  maxNameLength: 100,
  maxIntentionLength: 1_000,
} as const

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i

export type ScheduleAtInput =
  | { at: string; afterSeconds?: never }
  | { at?: never; afterSeconds: number }

export type ScheduleErrorCode = 'invalid_schedule' | 'outside_schedule_window'

export class ScheduleModelError extends Error {
  readonly code: ScheduleErrorCode

  constructor(code: ScheduleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduleModelError'
    this.code = code
  }
}

const inputSchema = z.union([
  z.object({ at: z.string().min(1) }).strict(),
  z.object({ afterSeconds: z.number().finite().positive() }).strict(),
])

export function normalizeScheduleAt(input: unknown, now: Date): string {
  assertValidDate(now, 'now')
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    throw new ScheduleModelError('invalid_schedule', 'Exactly one of at or afterSeconds is required', {
      cause: parsed.error,
    })
  }

  const at = 'at' in parsed.data
    ? parseDate(parsed.data.at)
    : new Date(now.getTime() + parsed.data.afterSeconds * 1_000)
  assertValidDate(at, 'at')
  const delayMs = at.getTime() - now.getTime()
  if (delayMs < SCHEDULE_LIMITS.minAtDelayMs || delayMs > SCHEDULE_LIMITS.maxLifetimeMs) {
    throw new ScheduleModelError(
      'outside_schedule_window',
      'Schedules must run between 30 seconds and three days from now',
    )
  }
  return at.toISOString()
}

export function parseStoredScheduleAt(value: string): string {
  return parseDate(value).toISOString()
}

function parseDate(value: string): Date {
  const match = ISO_TIMESTAMP_PATTERN.exec(value)
  if (!match) {
    throw new ScheduleModelError(
      'invalid_schedule',
      'at must be an ISO timestamp with an explicit timezone offset',
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
    month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59
  ) {
    throw new ScheduleModelError('invalid_schedule', 'at is not a real calendar time')
  }
  const date = new Date(value)
  assertValidDate(date, 'at')
  return date
}

function assertValidDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new ScheduleModelError('invalid_schedule', `${field} must be a valid date`)
  }
}
