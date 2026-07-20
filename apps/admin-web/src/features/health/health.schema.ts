import { z } from 'zod'

const issueSchema = z.object({ code: z.string(), message: z.string(), entryId: z.string().optional() }).strict()

export const healthSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  process: z.object({
    pidFilePresent: z.boolean(),
    pid: z.number().int().positive().nullable(),
    reachable: z.boolean(),
    label: z.string(),
  }).strict(),
  database: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  ledger: z.object({
    ok: z.boolean(),
    headEntryId: z.string().nullable(),
    latestCompactionEntryId: z.string().nullable(),
    permanentEntryCount: z.number().int().nonnegative(),
    activeEntryCount: z.number().int().nonnegative(),
    projectionTokens: z.number().int().nonnegative(),
    checkpointStatus: z.enum(['hit', 'missing', 'stale', 'corrupt']),
    errors: z.array(issueSchema),
  }).strict(),
  knowledge: z.object({
    ok: z.boolean(),
    counts: z.object({
      memory: z.object({ files: z.number().int().nonnegative(), entries: z.number().int().nonnegative() }).strict(),
      notebook: z.object({ files: z.number().int().nonnegative(), entries: z.number().int().nonnegative() }).strict(),
      lifeJournal: z.object({ files: z.number().int().nonnegative(), entries: z.number().int().nonnegative() }).strict(),
    }).strict(),
    lifecycle: z.object({
      expired: z.number().int().nonnegative(),
      disputed: z.number().int().nonnegative(),
      superseded: z.number().int().nonnegative(),
      stableWithoutSources: z.number().int().nonnegative(),
    }).strict(),
    issueCount: z.number().int().nonnegative(),
    agendaExists: z.boolean(),
  }).strict(),
  contextSurface: z.object({
    status: z.enum(['available', 'missing', 'invalid']),
    generatedAt: z.iso.datetime({ offset: true }).nullable(),
    ageSeconds: z.number().int().nonnegative().nullable(),
  }).strict(),
  migrations: z.object({ files: z.number().int().nonnegative(), applied: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
  warnings: z.array(z.string()),
}).strict()

export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>
