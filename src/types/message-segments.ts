export interface TextSegment {
  type: 'text'
  content: string
}

export interface ImageSegment {
  type: 'image'
  referenceId?: string
  url?: string
  fileSize?: string
  fileName?: string
  summary?: string
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

export interface RawSegment {
  type: 'raw'
  originalType: string
  data: unknown
}

export type ParsedSegment =
  | TextSegment
  | ImageSegment
  | FaceSegment
  | AtSegment
  | ReplySegment
  | RawSegment
