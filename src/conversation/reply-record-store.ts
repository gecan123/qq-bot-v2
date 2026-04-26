import { makeMainAgentRuntimeKey, makeMentionReplyIntentId } from '../runtime/types.js'
import type { AssistantTurnRecord } from './assistant-turn-store.js'

export type ReplyRecordExecutionState = 'pending' | 'sending' | 'acked' | 'sent' | 'failed' | 'dry_run' | 'suppressed'

export type ReplyDeliveryPayload =
  | { type: 'reply_to_message'; groupId?: number; messageId?: number; replyToMessageId?: number; mentionUserId?: number }
  | { type: 'send_message'; groupId?: number }
  | { type: 'send_private_message'; userId?: number }
  | { type: 'audit_only'; groupId?: number }

export interface ReplyRecord {
  id: number
  runtimeKey: string
  groupId: number
  scopeKey: string
  replyIntentId: string
  sourceKind: string
  triggerMessageRowId?: number | null
  incorporatedMessageRowId?: number | null
  deliveryPayload: ReplyDeliveryPayload
  text: string
  executionState?: ReplyRecordExecutionState
  providerMessageId?: number | null
  attemptCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateOrReuseReplyRecordInput {
  runtimeKey: string
  groupId: number
  scopeKey: string
  replyIntentId: string
  sourceKind: string
  triggerMessageRowId?: number | null
  incorporatedMessageRowId?: number | null
  deliveryPayload: ReplyDeliveryPayload
  text: string
  executionState?: ReplyRecordExecutionState
}

const records = new Map<string, ReplyRecord>()
let nextId = 1

function key(runtimeKey: string, replyIntentId: string): string {
  return `${runtimeKey}:${replyIntentId}`
}

export async function findReplyRecordByReplyIntentId(
  runtimeKey: string,
  replyIntentId: string,
): Promise<ReplyRecord | null> {
  return records.get(key(runtimeKey, replyIntentId)) ?? null
}

export async function createOrReuseReplyRecord(input: CreateOrReuseReplyRecordInput): Promise<ReplyRecord> {
  const recordKey = key(input.runtimeKey, input.replyIntentId)
  const existing = records.get(recordKey)
  if (existing) return existing
  const now = new Date()
  const record: ReplyRecord = {
    id: nextId++,
    runtimeKey: input.runtimeKey,
    groupId: input.groupId,
    scopeKey: input.scopeKey,
    replyIntentId: input.replyIntentId,
    sourceKind: input.sourceKind,
    triggerMessageRowId: input.triggerMessageRowId ?? null,
    incorporatedMessageRowId: input.incorporatedMessageRowId ?? null,
    deliveryPayload: input.deliveryPayload,
    text: input.text,
    executionState: input.executionState ?? 'pending',
    providerMessageId: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  records.set(recordKey, record)
  return record
}

export async function listRecoverableReplyRecords(_groups?: number[]): Promise<ReplyRecord[]> {
  return [...records.values()].filter((record) => ['pending', 'sending', 'acked', 'failed'].includes(record.executionState ?? 'pending'))
}

export async function listSentReplyRecords(groupId: number, scopeKey: string): Promise<ReplyRecord[]> {
  return [...records.values()].filter((record) => record.groupId === groupId && record.scopeKey === scopeKey && record.executionState === 'sent')
}

export async function listSentReplyRecordsAfterMessageRowId(
  groupId: number,
  scopeKey: string,
  messageRowId: number,
): Promise<ReplyRecord[]> {
  return (await listSentReplyRecords(groupId, scopeKey)).filter((record) => (record.incorporatedMessageRowId ?? 0) > messageRowId)
}

export async function getLatestSentReplyRecord(groupId: number, scopeKey: string): Promise<ReplyRecord | null> {
  return (await listSentReplyRecords(groupId, scopeKey)).at(-1) ?? null
}

async function mark(id: number, executionState: ReplyRecordExecutionState, providerMessageId?: number): Promise<void> {
  for (const record of records.values()) {
    if (record.id !== id) continue
    record.executionState = executionState
    if (providerMessageId !== undefined) record.providerMessageId = providerMessageId
    record.updatedAt = new Date()
    return
  }
}

export async function markReplyRecordSending(id: number): Promise<void> {
  await mark(id, 'sending')
}

export async function markReplyRecordAcked(id: number, providerMessageId: number): Promise<void> {
  await mark(id, 'acked', providerMessageId)
}

export async function markReplyRecordSent(id: number): Promise<void> {
  await mark(id, 'sent')
}

export async function markReplyRecordFailed(id: number): Promise<void> {
  await mark(id, 'failed')
}

export async function markReplyRecordSuppressed(id: number): Promise<void> {
  await mark(id, 'suppressed')
}

export async function upsertReplyRecordFromLegacyAssistantTurn(turn: AssistantTurnRecord): Promise<ReplyRecord> {
  return createOrReuseReplyRecord({
    runtimeKey: makeMainAgentRuntimeKey(),
    groupId: turn.groupId,
    scopeKey: turn.senderThreadKey,
    replyIntentId: makeMentionReplyIntentId(turn.groupId, turn.triggerMessageRowId),
    sourceKind: 'mention',
    triggerMessageRowId: turn.triggerMessageRowId,
    incorporatedMessageRowId: turn.incorporatedMessageRowId,
    deliveryPayload: {
      type: 'reply_to_message',
      groupId: turn.groupId,
      messageId: turn.replyToMessageId,
      mentionUserId: turn.mentionUserId ?? undefined,
    },
    text: turn.text,
    executionState: turn.status as ReplyRecordExecutionState,
  })
}
