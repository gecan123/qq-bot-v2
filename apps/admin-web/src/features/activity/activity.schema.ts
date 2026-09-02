import { z } from 'zod'

const activityTargetSchema = z.object({
  platform: z.enum(['qq', 'feishu']),
  accountId: z.string().min(1),
  kind: z.enum(['group', 'private']),
  externalId: z.string().min(1),
}).strict()

export const liveAgentActivitySchema = z.object({
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
    target: activityTargetSchema.nullable(),
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
}).strict()

export type LiveAgentActivity = z.infer<typeof liveAgentActivitySchema>
