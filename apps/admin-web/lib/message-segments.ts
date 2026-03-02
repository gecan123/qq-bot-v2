export interface TextSegment {
  type: "text";
  content: string;
}

export interface ImageSegment {
  type: "image";
  referenceId?: string;
  url?: string;
  fileSize?: string;
  fileName?: string;
  summary?: string;
  subType?: number;
}

export interface FaceSegment {
  type: "face";
  faceId: number;
  name?: string;
}

export interface AtSegment {
  type: "at";
  targetId: string;
  targetName?: string;
}

export interface ReplySegment {
  type: "reply";
  messageId: string;
}

export interface VideoSegment {
  type: "video";
  referenceId?: string;
  url?: string;
  fileName?: string;
  fileSize?: string;
  description?: string;
}

export interface RecordSegment {
  type: "record";
  referenceId?: string;
  url?: string;
  fileName?: string;
  fileSize?: string;
  description?: string;
}

export interface FileSegment {
  type: "file";
  referenceId?: string;
  url?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: string;
  description?: string;
}

export interface RawSegment {
  type: "raw";
  originalType: string;
  data: unknown;
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
  | RawSegment;
