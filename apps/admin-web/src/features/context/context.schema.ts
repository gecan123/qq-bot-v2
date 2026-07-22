import { z } from 'zod'

export const contextSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  ledger: z.object({
    total: z.number().int().nonnegative(),
    headId: z.string().nullable(),
    checkpointThroughId: z.string().nullable(),
    checkpointUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
    typeCounts: z.array(z.object({ type: z.string(), count: z.number().int().nonnegative() }).strict()),
  }).strict(),
  runtime: z.object({
    ledgerHeadId: z.string().nullable(),
    goalRevision: z.number().int().nonnegative().nullable(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  latestUsage: z.object({
    ts: z.iso.datetime({ offset: true }),
    model: z.string(),
    inputTokens: z.number().nullable(),
    cachedTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheHitRate: z.number().nullable(),
  }).strict().nullable(),
  entries: z.array(z.object({
    id: z.string(),
    entryType: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    role: z.string().nullable(),
    preview: z.string(),
  }).strict()),
  warnings: z.array(z.string()),
}).strict()

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>
