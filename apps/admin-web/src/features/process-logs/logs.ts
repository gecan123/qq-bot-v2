import { z } from 'zod'

export const PROCESS_LOG_SOURCES = [
  'agent-core',
  'qq-gateway',
  'llm-gateway',
  'media-worker',
  'scheduler',
  'browser-controller',
  'web-admin',
] as const

export const processLogSourceSchema = z.enum(PROCESS_LOG_SOURCES)
export type ProcessLogSource = z.infer<typeof processLogSourceSchema>

export const processLogLevelSchema = z.enum([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'unknown',
])
export type ProcessLogLevel = z.infer<typeof processLogLevelSchema>

export const processLogEntrySchema = z.object({
  sequence: z.number().int().positive(),
  level: processLogLevelSchema,
  text: z.string(),
}).strict()
export type ProcessLogEntry = z.infer<typeof processLogEntrySchema>

export const processLogSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  selectedSource: processLogSourceSchema,
  sources: z.array(z.object({
    id: processLogSourceSchema,
    label: z.string(),
    exists: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict()),
  entries: z.array(processLogEntrySchema),
  bytesTruncated: z.boolean(),
  lineLimitTruncated: z.boolean(),
  warnings: z.array(z.string()),
}).strict()
export type ProcessLogSnapshot = z.infer<typeof processLogSnapshotSchema>

export function parseProcessLogTail(
  content: string,
  options: { bytesTruncated: boolean; limit: number },
): {
  entries: ProcessLogEntry[]
  leadingPartialLineDropped: boolean
  lineLimitTruncated: boolean
} {
  const normalized = stripAnsi(content)
  const lines = normalized.split(/\r?\n/)
  const leadingPartialLineDropped = options.bytesTruncated && lines.length > 0
  if (leadingPartialLineDropped) lines.shift()
  while (lines.at(-1) === '') lines.pop()

  const nonEmptyLines = lines.filter(line => line.trim().length > 0)
  const limit = Math.max(1, Math.floor(options.limit))
  const lineLimitTruncated = nonEmptyLines.length > limit
  const retained = nonEmptyLines.slice(-limit)

  return {
    entries: retained.map((text, index) => ({
      sequence: index + 1,
      level: classifyLogLevel(text),
      text,
    })),
    leadingPartialLineDropped,
    lineLimitTruncated,
  }
}

function classifyLogLevel(line: string): ProcessLogLevel {
  const match = /(?:^|\s)(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)(?:\s|$)/i.exec(line)
  if (!match) return 'unknown'
  return match[1]!.toLowerCase() as ProcessLogLevel
}

function stripAnsi(value: string): string {
  // Covers CSI color/style sequences produced by pino-pretty without
  // interpreting arbitrary terminal control input in the browser.
  return value.replaceAll(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  )
}
