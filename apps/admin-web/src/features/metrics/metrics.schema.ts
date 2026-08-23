import { z } from 'zod'

const toolStat = z.object({
  name: z.string(), calls: z.number(), failed: z.number(), sideEffects: z.number(),
  avgMs: z.number(), p95Ms: z.number(), maxMs: z.number(),
}).strict()
const tokenStat = z.object({
  name: z.string(), calls: z.number(), input: z.number(), cached: z.number(), output: z.number(),
  cacheHitRate: z.number().nullable(),
}).strict()
const coverageSchema = z.object({
  source: z.enum(['ndjson', 'database']),
  status: z.enum(['available', 'missing', 'invalid']),
  truncated: z.boolean(),
  from: z.iso.datetime({ offset: true }).nullable(),
  to: z.iso.datetime({ offset: true }).nullable(),
}).strict()

export const metricsSnapshotSchema = z.object({
  schemaVersion: z.literal(3),
  generatedAt: z.iso.datetime({ offset: true }),
  window: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  }).strict(),
  coverage: z.object({
    tools: coverageSchema.extend({ mode: z.enum(['all', 'side_effects', 'off']) }).strict(),
    tokens: coverageSchema,
  }).strict(),
  totals: z.object({
    toolCalls: z.number(), failedTools: z.number(), sideEffects: z.number(), inputTokens: z.number(),
    cachedTokens: z.number(), outputTokens: z.number(), cacheHitRate: z.number().nullable(),
  }).strict(),
  days: z.array(z.object({
    day: z.string(), tools: z.number(), failed: z.number(), input: z.number(), cached: z.number(), output: z.number(),
  }).strict()),
  tools: z.array(toolStat),
  operations: z.array(tokenStat),
  models: z.array(tokenStat),
  warnings: z.array(z.string()),
}).strict()

export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>
