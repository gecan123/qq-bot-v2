import { z } from 'zod'
const toolStat = z.object({ name: z.string(), calls: z.number(), failed: z.number(), sideEffects: z.number(), avgMs: z.number(), p95Ms: z.number(), maxMs: z.number() }).strict()
const tokenStat = z.object({ name: z.string(), calls: z.number(), input: z.number(), cached: z.number(), output: z.number(), cacheHitRate: z.number().nullable() }).strict()
export const metricsSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }), window: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).strict(),
  totals: z.object({ toolCalls: z.number(), failedTools: z.number(), sideEffects: z.number(), inputTokens: z.number(), cachedTokens: z.number(), outputTokens: z.number(), cacheHitRate: z.number().nullable() }).strict(),
  days: z.array(z.object({ day: z.string(), tools: z.number(), failed: z.number(), input: z.number(), cached: z.number(), output: z.number() }).strict()),
  tools: z.array(toolStat), operations: z.array(tokenStat), models: z.array(tokenStat),
}).strict()
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>
