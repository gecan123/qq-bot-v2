import { z } from 'zod'

export const qqMessageSchema = z.object({
  id: z.number(), scene: z.string(), sceneKind: z.string(), sender: z.string(), senderId: z.string(),
  at: z.iso.datetime({ offset: true }), text: z.string(), mediaReferenceIds: z.array(z.string()),
}).strict()

export const qqMediaSchema = z.object({
  id: z.number(), contentType: z.string().nullable(), fileName: z.string().nullable(), fileSize: z.number().nullable(),
  createdAt: z.iso.datetime({ offset: true }), description: z.string().nullable(), descriptionIsJson: z.boolean(),
  dataUrl: z.string().nullable(), stickerName: z.string().nullable(), stickerTags: z.array(z.string()),
}).strict()

export const qqSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  counts: z.object({ messages: z.number(), media: z.number(), stickers: z.number(), groups: z.number() }).strict(),
  groups: z.array(z.object({ groupId: z.string().regex(/^\d+$/), name: z.string(), messageCount: z.number().int().nonnegative(), lastAt: z.iso.datetime({ offset: true }) }).strict()),
  messages: z.array(qqMessageSchema),
  media: z.array(qqMediaSchema),
  note: z.string(),
}).strict()

export const qqGroupInputSchema = z.object({ groupId: z.string().regex(/^\d+$/) }).strict()

export const qqGroupSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  group: z.object({ groupId: z.string(), name: z.string(), totalMessages: z.number(), firstAt: z.iso.datetime({ offset: true }).nullable(), lastAt: z.iso.datetime({ offset: true }).nullable(), windowLimited: z.boolean() }).strict(),
  participants: z.array(z.object({ senderId: z.string(), name: z.string(), messages: z.number(), lastAt: z.iso.datetime({ offset: true }) }).strict()),
  messages: z.array(qqMessageSchema),
  media: z.array(qqMediaSchema),
}).strict()

export type QqSnapshot = z.infer<typeof qqSnapshotSchema>
export type QqGroupSnapshot = z.infer<typeof qqGroupSnapshotSchema>
