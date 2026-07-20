import { z } from 'zod'

const focusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), id: z.string().regex(/^\d+$/) }).strict(),
  z.object({ type: z.literal('private'), id: z.string().regex(/^\d+$/) }).strict(),
])

export const overviewSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
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
  goal: z.object({
    goalId: z.string().uuid(),
    objective: z.string(),
    status: z.string(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
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
