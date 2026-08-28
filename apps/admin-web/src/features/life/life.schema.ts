import { z } from 'zod'

export const lifeSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  schedules: z.array(z.object({ id: z.string(), label: z.string(), status: z.string(), nextRunAt: z.string().nullable() }).strict()),
  backgroundTasks: z.array(z.object({ id: z.string(), toolName: z.string(), description: z.string(), status: z.string(), attempt: z.number(), updatedAt: z.string().nullable(), summary: z.string().nullable() }).strict()),
  runtime: z.object({ lastWakeAt: z.iso.datetime({ offset: true }).nullable(), updatedAt: z.iso.datetime({ offset: true }).nullable(), focus: z.json().nullable(), mailboxCount: z.number(), inboxReadCount: z.number() }).strict(),
  notes: z.array(z.string()),
}).strict()
export type LifeSnapshot = z.infer<typeof lifeSnapshotSchema>
