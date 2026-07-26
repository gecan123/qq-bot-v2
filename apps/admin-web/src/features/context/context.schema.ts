import { z } from 'zod'

const evidenceDigestSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  toolNames: z.array(z.string()),
}).strict()

export const contextSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
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
  recentLlmCalls: z.array(z.object({
    callId: z.string().uuid(),
    ts: z.iso.datetime({ offset: true }),
    operation: z.string(),
    actor: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string(),
    status: z.enum(['succeeded', 'failed', 'aborted']),
    durationMs: z.number().int().nonnegative().nullable(),
    stopReason: z.string().nullable(),
    errorKind: z.string().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    evidence: z.object({
      canonicalRequest: evidenceDigestSchema.nullable(),
      providerRequest: evidenceDigestSchema.nullable(),
      providerResponse: evidenceDigestSchema.nullable(),
      canonicalResponse: evidenceDigestSchema.nullable(),
    }).strict().nullable(),
  }).strict()),
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
