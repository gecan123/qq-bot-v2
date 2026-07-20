import { z } from 'zod'

export const memoryEntrySchema = z.object({
  id: z.string(),
  fileId: z.string(),
  file: z.string(),
  tier: z.string().nullable(),
  status: z.string().nullable(),
  evidenceKind: z.string().nullable(),
  updatedAt: z.string().nullable(),
  sourceMessageIds: z.array(z.number()),
  text: z.string(),
}).strict()

export const memoryProvenanceSchema = z.object({
  id: z.number(),
  scene: z.string(),
  sender: z.string(),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  text: z.string(),
}).strict()

export const memorySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  counts: z.object({ files: z.number(), entries: z.number(), journalFiles: z.number(), journalEntries: z.number(), sourceLinks: z.number() }).strict(),
  files: z.array(z.object({ fileId: z.string(), path: z.string(), kind: z.enum(['memory', 'journal', 'notebook']), updatedAt: z.iso.datetime({ offset: true }), size: z.number(), entryCount: z.number() }).strict()),
  entries: z.array(memoryEntrySchema),
  provenance: z.array(memoryProvenanceSchema),
  warnings: z.array(z.string()),
}).strict()

export const memoryFileInputSchema = z.object({ fileId: z.string().min(1).max(1_024) }).strict()

export const memoryFileSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  file: z.object({
    fileId: z.string(),
    path: z.string(),
    kind: z.enum(['memory', 'journal', 'notebook']),
    updatedAt: z.iso.datetime({ offset: true }),
    size: z.number().int().nonnegative(),
    title: z.string(),
    metadata: z.record(z.string(), z.string()),
    rawMarkdown: z.string(),
  }).strict(),
  entries: z.array(memoryEntrySchema),
  provenance: z.array(memoryProvenanceSchema),
}).strict()

export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>
export type MemoryFileSnapshot = z.infer<typeof memoryFileSnapshotSchema>
