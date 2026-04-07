export type MediaDescription = Record<string, unknown>

export interface TextSegment {
  type: 'text'
  content: string
}

interface BaseMediaSegment {
  referenceId?: string
  url?: string
  fileName?: string
  fileSize?: string
  mediaDescription?: MediaDescription
}

export interface ImageSegment {
  type: 'image'
  referenceId?: string
  url?: string
  fileSize?: string
  fileName?: string
  mediaDescription?: MediaDescription
  subType?: number
}

export interface FaceSegment {
  type: 'face'
  faceId: number
  name?: string
}

export interface AtSegment {
  type: 'at'
  targetId: string
  targetName?: string
}

export interface ReplySegment {
  type: 'reply'
  messageId: string
}

export interface VideoSegment extends BaseMediaSegment {
  type: 'video'
}

export interface RecordSegment extends BaseMediaSegment {
  type: 'record'
}

export interface FileSegment extends BaseMediaSegment {
  type: 'file'
  fileId?: string
}

export interface JsonCardSegment {
  type: 'json_card'
  title?: string
  desc?: string
  url?: string
  source?: string
  prompt?: string
}

export interface RawSegment {
  type: 'raw'
  originalType: string
  data: unknown
}

export type ParsedSegment =
  | TextSegment
  | ImageSegment
  | VideoSegment
  | RecordSegment
  | FileSegment
  | FaceSegment
  | AtSegment
  | ReplySegment
  | JsonCardSegment
  | RawSegment
