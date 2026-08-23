import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

export const MAILBOX_WATCHER_STATUS_PATH = 'logs/mailbox-watcher-status.json'

export const mailboxWatcherStatusSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  cursor: z.number().int().nonnegative(),
  blockedAtRowId: z.number().int().positive().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastErrorKind: z.string().min(1).max(120).nullable(),
  lastFailedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict()

export type MailboxWatcherStatus = z.infer<typeof mailboxWatcherStatusSchema>

export function shouldPublishMailboxWatcherStatus(input: {
  current: MailboxWatcherStatus
  previous: MailboxWatcherStatus | null
  lastPublishedAtMs: number | null
  nowMs: number
  heartbeatMs: number
}): boolean {
  if (input.previous == null || input.lastPublishedAtMs == null) return true
  if (!sameOperationalStatus(input.current, input.previous)) return true
  return input.nowMs - input.lastPublishedAtMs >= input.heartbeatMs
}

export function initialMailboxWatcherStatus(cursor: number, now = new Date()): MailboxWatcherStatus {
  return mailboxWatcherStatusSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    cursor,
    blockedAtRowId: null,
    consecutiveFailures: 0,
    lastErrorKind: null,
    lastFailedAt: null,
  })
}

export function recordMailboxWatcherSuccess(
  current: MailboxWatcherStatus,
  cursor: number,
  now = new Date(),
): MailboxWatcherStatus {
  return mailboxWatcherStatusSchema.parse({
    ...current,
    generatedAt: now.toISOString(),
    cursor,
    blockedAtRowId: null,
    consecutiveFailures: 0,
    lastErrorKind: null,
    lastFailedAt: null,
  })
}

export function recordMailboxWatcherFailure(
  current: MailboxWatcherStatus,
  blockedAtRowId: number | null,
  error: unknown,
  now = new Date(),
): MailboxWatcherStatus {
  const sameFailure = current.blockedAtRowId === blockedAtRowId
    && current.lastErrorKind === errorKind(error)
  return mailboxWatcherStatusSchema.parse({
    ...current,
    generatedAt: now.toISOString(),
    blockedAtRowId,
    consecutiveFailures: sameFailure ? current.consecutiveFailures + 1 : 1,
    lastErrorKind: errorKind(error),
    lastFailedAt: now.toISOString(),
  })
}

export async function writeMailboxWatcherStatus(
  path: string,
  status: MailboxWatcherStatus,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(mailboxWatcherStatusSchema.parse(status))}\n`, 'utf8')
  await rename(tempPath, path)
}

function sameOperationalStatus(left: MailboxWatcherStatus, right: MailboxWatcherStatus): boolean {
  return left.cursor === right.cursor
    && left.blockedAtRowId === right.blockedAtRowId
    && left.lastErrorKind === right.lastErrorKind
}

function errorKind(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.slice(0, 120)
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.slice(0, 120)
  }
  return typeof error
}
