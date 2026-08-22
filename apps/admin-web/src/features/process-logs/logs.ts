import { z } from 'zod'

export const PROCESS_LOG_SOURCES = [
  'agent-core',
  'qq-gateway',
  'media-worker',
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

const processLogMetadataSchema = z.record(z.string(), z.json())
type ProcessLogMetadata = z.infer<typeof processLogMetadataSchema>

export const processLogEntrySchema = z.object({
  sequence: z.number().int().positive(),
  level: processLogLevelSchema,
  timestamp: z.iso.datetime({ offset: true }).nullable(),
  scope: z.string().nullable(),
  message: z.string(),
  metadata: processLogMetadataSchema.nullable(),
  detail: z.string().nullable(),
  text: z.string(),
}).strict()
export type ProcessLogEntry = z.infer<typeof processLogEntrySchema>

export const processLogSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
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
  if (options.bytesTruncated) {
    const firstCompleteEntry = lines.findIndex(line => parsePrettyLine(line) !== null)
    if (firstCompleteEntry > 0) lines.splice(0, firstCompleteEntry)
  }

  const grouped: Array<{ lines: string[]; parsed: ParsedPrettyLine | null }> = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const parsed = parsePrettyLine(line)
    const previous = grouped.at(-1)
    if (!parsed && previous?.parsed && /^\s/.test(line)) {
      previous.lines.push(line)
      continue
    }
    grouped.push({ lines: [line], parsed })
  }

  const limit = Math.max(1, Math.floor(options.limit))
  const lineLimitTruncated = grouped.length > limit
  const retained = grouped.slice(-limit)

  return {
    entries: retained.map(({ lines: entryLines, parsed }, index) => {
      const text = entryLines.join('\n')
      if (!parsed) {
        return {
          sequence: index + 1,
          level: classifyLogLevel(text),
          timestamp: null,
          scope: null,
          message: text,
          metadata: null,
          detail: null,
          text,
        }
      }
      return {
        sequence: index + 1,
        level: parsed.level,
        timestamp: parsed.timestamp,
        scope: parsed.scope,
        message: parsed.message,
        metadata: parsed.metadata,
        detail: entryLines.length > 1 ? entryLines.slice(1).join('\n') : null,
        text,
      }
    }),
    leadingPartialLineDropped,
    lineLimitTruncated,
  }
}

type ParsedPrettyLine = {
  level: Exclude<ProcessLogLevel, 'unknown'>
  timestamp: string
  scope: string | null
  message: string
  metadata: ProcessLogMetadata | null
}

function parsePrettyLine(line: string): ParsedPrettyLine | null {
  const match = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]+)\]:\s+(?:\[([^\]]+)\]\s+)?(.*)$/i.exec(line)
  if (!match) return null
  const { message, metadata } = splitMetadata(match[4] ?? '')
  return {
    level: match[1]!.toLowerCase() as ParsedPrettyLine['level'],
    timestamp: match[2]!,
    scope: match[3] ?? null,
    message,
    metadata,
  }
}

function splitMetadata(value: string): { message: string; metadata: ProcessLogMetadata | null } {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '{' || (index > 0 && !/\s/.test(value[index - 1]!))) continue
    try {
      const candidate: unknown = JSON.parse(value.slice(index))
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      return {
        message: value.slice(0, index).trimEnd(),
        metadata: candidate as ProcessLogMetadata,
      }
    } catch {
      // A brace in the human-readable message is not structured metadata.
    }
  }
  return { message: value, metadata: null }
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
