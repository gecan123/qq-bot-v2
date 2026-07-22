import { z } from 'zod'

export const lifeSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  goal: z.object({
    goalId: z.string(), objective: z.string(), origin: z.string(), motivation: z.string().nullable(), status: z.string(),
    completionCriteria: z.json().nullable(), currentCommitment: z.json().nullable(), completionEvidence: z.json().nullable(),
    tokenBudget: z.number().nullable(), tokensUsed: z.number(), timeUsedSeconds: z.number(), roundsUsed: z.number(), revision: z.number(),
    blockerKey: z.string().nullable(), blockerTurns: z.number(), blockedReason: z.string().nullable(), updatedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
  agenda: z.object({ exists: z.boolean(), markdown: z.string(), sections: z.record(z.string(), z.number()) }).strict(),
  schedules: z.array(z.object({ id: z.string(), label: z.string(), status: z.string(), nextRunAt: z.string().nullable() }).strict()),
  backgroundTasks: z.array(z.object({ id: z.string(), toolName: z.string(), description: z.string(), status: z.string(), attempt: z.number(), updatedAt: z.string().nullable(), summary: z.string().nullable() }).strict()),
  runtime: z.object({ lastWakeAt: z.iso.datetime({ offset: true }).nullable(), updatedAt: z.iso.datetime({ offset: true }).nullable(), focus: z.json().nullable(), mailboxCount: z.number(), inboxReadCount: z.number() }).strict(),
  notes: z.array(z.string()),
}).strict()
export type LifeSnapshot = z.infer<typeof lifeSnapshotSchema>
