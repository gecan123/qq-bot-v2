import { z } from 'zod'
import { liveAgentActivitySchema } from '../activity/activity.schema.js'

const focusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('private'), id: z.string().min(1) }).strict(),
])

export const overviewSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime({ offset: true }),
  readOnly: z.literal(true),
  ledger: z.object({
    entryCount: z.number().int().nonnegative(),
    headEntryId: z.string().regex(/^\d+$/).nullable(),
    latestEntryType: z.string().nullable(),
    latestEntryAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  runtime: z.object({
    available: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
    lastWakeAt: z.iso.datetime({ offset: true }).nullable(),
    focus: focusSchema.nullable(),
  }).strict(),
  activity: liveAgentActivitySchema,
  recentActions: z.array(z.object({
    id: z.string(),
    at: z.iso.datetime({ offset: true }),
    title: z.string(),
    detail: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    sideEffect: z.boolean(),
    toolName: z.string(),
    toolCallId: z.string(),
    roundIndex: z.number().int().nonnegative(),
    argsSummary: z.json(),
  }).strict()),
  latestAgentUsage: z.object({
    ts: z.iso.datetime({ offset: true }),
    model: z.string(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cacheHitRate: z.number().min(0).max(1).nullable(),
  }).strict().nullable(),
  tools24h: z.object({
    calls: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
  warnings: z.array(z.string()),
}).strict()

export type OverviewSnapshot = z.infer<typeof overviewSnapshotSchema>
