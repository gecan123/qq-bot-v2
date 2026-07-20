import { z } from 'zod'

export const timelineSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  events: z.array(z.object({
    key: z.string(), at: z.iso.datetime({ offset: true }), kind: z.enum(['ledger', 'tool', 'token']),
    title: z.string(), detail: z.string(), jsonDetail: z.string().nullable(), ok: z.boolean().nullable(), sideEffect: z.boolean().nullable(),
    roundIndex: z.number().int().nullable(), correlation: z.enum(['canonical', 'toolCallId', 'roundIndex_best_effort']),
  }).strict()),
  summary: z.object({ ledger: z.number(), tools: z.number(), failedTools: z.number(), sideEffects: z.number(), tokenEvents: z.number() }).strict(),
  warning: z.string(),
}).strict()
export type TimelineSnapshot = z.infer<typeof timelineSnapshotSchema>
