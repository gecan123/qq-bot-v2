import { z } from 'zod'
import { liveAgentActivitySchema } from '../activity/activity.schema.js'

const evidenceDigestSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  toolNames: z.array(z.string()),
}).strict()

const contextThinkingBlockTypeSchema = z.enum(['thinking', 'redacted_thinking'])
const contextThinkingBlockIndexSchema = z.object({
  blockIndex: z.number().int().nonnegative(),
  type: contextThinkingBlockTypeSchema,
  charCount: z.number().int().nonnegative(),
}).strict()

const contextEntryBaseSchema = z.object({
  id: z.string(),
  entryType: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  rawPreview: z.string(),
}).strict()

const contextMessageEntrySchema = contextEntryBaseSchema.extend({
  kind: z.literal('message'),
  entryType: z.literal('message'),
  role: z.enum(['user', 'assistant', 'tool']),
  summary: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
    transportName: z.string().nullable(),
    argsPreview: z.string(),
    parameters: z.array(z.object({
      label: z.string(),
      value: z.string(),
    }).strict()),
  }).strict()),
  thinkingBlocks: z.array(contextThinkingBlockIndexSchema),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  parentEntryId: z.string().nullable(),
  result: z.object({
    ok: z.boolean().nullable(),
    status: z.string().nullable(),
    code: z.string().nullable(),
    reason: z.string().nullable(),
  }).strict().nullable(),
}).strict()

const contextCompactionEntrySchema = contextEntryBaseSchema.extend({
  kind: z.literal('compaction'),
  entryType: z.literal('compaction'),
  role: z.null(),
  summary: z.string(),
  reason: z.string().nullable(),
  firstKeptEntryId: z.string().nullable(),
  tokensBefore: z.number().int().nonnegative().nullable(),
  estimatedTokensAfter: z.number().int().nonnegative().nullable(),
  isSplitTurn: z.boolean().nullable(),
}).strict()

const contextUnknownEntrySchema = contextEntryBaseSchema.extend({
  kind: z.literal('unknown'),
  role: z.null(),
  parseError: z.string(),
}).strict()

export const contextLedgerEntrySchema = z.discriminatedUnion('kind', [
  contextMessageEntrySchema,
  contextCompactionEntrySchema,
  contextUnknownEntrySchema,
])

export const contextThinkingBlockInputSchema = z.object({
  entryId: z.string().regex(/^\d+$/),
  blockIndex: z.number().int().nonnegative(),
}).strict()

export const contextThinkingArchiveSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    entryId: z.string().regex(/^\d+$/),
    createdAt: z.iso.datetime({ offset: true }),
    blocks: z.array(contextThinkingBlockIndexSchema).min(1),
  }).strict()),
}).strict()

export const contextThinkingBlockSchema = z.object({
  schemaVersion: z.literal(1),
  entryId: z.string().regex(/^\d+$/),
  blockIndex: z.number().int().nonnegative(),
  type: contextThinkingBlockTypeSchema,
  thinking: z.string().nullable(),
}).strict()

export const contextSnapshotSchema = z.object({
  schemaVersion: z.literal(7),
  generatedAt: z.iso.datetime({ offset: true }),
  activity: liveAgentActivitySchema,
  ledger: z.object({
    total: z.number().int().nonnegative(),
    headId: z.string().nullable(),
    checkpointThroughId: z.string().nullable(),
    checkpointUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
    typeCounts: z.array(z.object({ type: z.string(), count: z.number().int().nonnegative() }).strict()),
  }).strict(),
  runtime: z.object({
    ledgerHeadId: z.string().nullable(),
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
  entries: z.array(contextLedgerEntrySchema),
  warnings: z.array(z.string()),
}).strict()

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>
export type ContextThinkingArchive = z.infer<typeof contextThinkingArchiveSchema>
export type ContextThinkingBlock = z.infer<typeof contextThinkingBlockSchema>
export type ContextThinkingBlockInput = z.infer<typeof contextThinkingBlockInputSchema>
