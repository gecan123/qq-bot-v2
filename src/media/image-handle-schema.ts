import { z } from 'zod'

export const imageHandleSchema = z.union([
  z.object({ mediaId: z.number().int().positive() }),
  z.object({ ephemeralRef: z.string().regex(/^[a-f0-9]{64}$/) }),
])

export type ImageHandle = z.infer<typeof imageHandleSchema>

export interface ImageProduceResult {
  ephemeralRef: string
  dataHash: string
  byteSize: number
  contentType: string
  description: string
}

export interface ResolvedImage {
  bytes: Buffer
  dataHash: string
  byteSize: number
  contentType: string
  description: string
}
