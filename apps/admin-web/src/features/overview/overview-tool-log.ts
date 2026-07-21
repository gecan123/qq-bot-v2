import { z } from 'zod'
import type { ToolCallLogEntry } from '../../../../../src/ops/tool-call-log.js'

const RECENT_TOOL_CALL_LIMIT = 16

const toolCallLogEntrySchema = z.object({
  ts: z.iso.datetime({ offset: true }),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  roundIndex: z.number().int().nonnegative(),
  argsSummary: z.json(),
  durationMs: z.number().int().nonnegative(),
  ok: z.boolean(),
  sideEffect: z.boolean(),
  error: z.string().optional(),
}).strict()

interface ParsedToolCall extends ToolCallLogEntry {
  timestampMs: number
  sequence: number
}

export interface ParsedOverviewToolLog {
  entries: ParsedToolCall[]
  invalidLines: number
}

export interface OverviewToolActivityInput {
  recentCalls: ToolCallLogEntry[]
  calls24h: number
  failed24h: number
  warnings: string[]
}

export function parseOverviewToolLog(content: string): ParsedOverviewToolLog {
  const entries: ParsedToolCall[] = []
  let invalidLines = 0

  for (const [sequence, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const parsed = toolCallLogEntrySchema.safeParse(JSON.parse(line))
      if (!parsed.success) {
        invalidLines++
        continue
      }
      entries.push({
        ...parsed.data,
        timestampMs: Date.parse(parsed.data.ts),
        sequence,
      })
    } catch {
      invalidLines++
    }
  }

  entries.sort((left, right) => (
    right.timestampMs - left.timestampMs || right.sequence - left.sequence
  ))
  return { entries, invalidLines }
}

export function summarizeOverviewToolLog(
  parsed: ParsedOverviewToolLog,
  now: Date,
  warnings: string[] = [],
): OverviewToolActivityInput {
  const sinceMs = now.getTime() - 24 * 60 * 60 * 1000
  let calls24h = 0
  let failed24h = 0

  for (const entry of parsed.entries) {
    if (entry.timestampMs < sinceMs || entry.timestampMs > now.getTime()) continue
    calls24h++
    if (!entry.ok) failed24h++
  }

  return {
    recentCalls: parsed.entries.slice(0, RECENT_TOOL_CALL_LIMIT).map(({ timestampMs: _, sequence: __, ...entry }) => entry),
    calls24h,
    failed24h,
    warnings: [
      ...warnings,
      ...(parsed.invalidLines > 0
        ? [`工具审计日志包含 ${parsed.invalidLines} 条无效记录，已跳过。`]
        : []),
    ],
  }
}
