import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from './segment-text.js'

export type BusinessLogDirection = 'inbound' | 'outbound' | 'internal'
export type BusinessLogActor = 'member' | 'bot' | 'system'
export type BusinessLogIngestSource = 'realtime' | 'backfill' | 'replay' | 'scheduler'
export type BusinessLogDispatchMode = 'live' | 'snapshot_only' | 'dry_run' | 'artifact_only' | 'audit_only'
export type BusinessLogSideEffect =
  | 'none'
  | 'db_write'
  | 'snapshot_write'
  | 'audit_write'
  | 'artifact_write'
  | 'reply_record_write'
  | 'napcat_send'
export type BusinessLogCategory =
  | 'group_message'
  | 'mention'
  | 'ambient_message'
  | 'mention_reply'
  | 'ambient_candidate'
  | 'reply_delivery'
  | 'runtime'

export interface BusinessLogFields {
  direction: BusinessLogDirection
  actor: BusinessLogActor
  category: BusinessLogCategory
  flow?: string
  ingestSource?: BusinessLogIngestSource
  dispatchMode?: BusinessLogDispatchMode
  sideEffect?: BusinessLogSideEffect
}

export function previewText(value: string | null | undefined, limit = 80): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function summarizeSegments(segments: ParsedSegment[]): {
  segmentCount: number
  segmentTypes: string[]
  textPreview: string
} {
  return {
    segmentCount: segments.length,
    segmentTypes: segments.map((segment) => segment.type),
    textPreview: previewText(segmentsToPlainText(segments)),
  }
}
