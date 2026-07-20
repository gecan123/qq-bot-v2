import { z } from 'zod'

const focusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), id: z.string().regex(/^\d+$/) }).strict(),
  z.object({ type: z.literal('private'), id: z.string().regex(/^\d+$/) }).strict(),
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
  goal: z.object({
    goalId: z.string().uuid(),
    objective: z.string(),
    status: z.string(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    revision: z.number().int().positive(),
    currentCommitment: z.object({
      action: z.string(),
      reason: z.string(),
      expectedEvidence: z.string(),
    }).strict().nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
  activity: z.object({
    available: z.boolean(),
    sourceStatus: z.enum(['available', 'missing', 'invalid', 'stale']),
    phase: z.enum(['starting', 'thinking', 'tool', 'resting', 'committing', 'waiting', 'error', 'stopping', 'stopped', 'unavailable']),
    phaseStartedAt: z.iso.datetime({ offset: true }).nullable(),
    roundIndex: z.number().int().nonnegative().nullable(),
    detail: z.string().nullable(),
    waitUntil: z.iso.datetime({ offset: true }).nullable(),
    trigger: z.object({
      kind: z.string(),
      label: z.string(),
      target: focusSchema.nullable(),
    }).strict().nullable(),
    activeTools: z.array(z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      roundIndex: z.number().int().nonnegative(),
      startedAt: z.iso.datetime({ offset: true }),
      argsSummary: z.json(),
    }).strict()),
    lastCompleted: z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      roundIndex: z.number().int().nonnegative(),
      at: z.iso.datetime({ offset: true }),
      durationMs: z.number().int().nonnegative(),
      ok: z.boolean(),
      error: z.string().nullable(),
    }).strict().nullable(),
  }).strict(),
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
