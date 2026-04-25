import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { BusinessLogIngestSource } from '../utils/business-log.js'
import {
  createOrReuseActionIntent,
  createOrReuseActionRecord,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  getAgentRuntimeSnapshot,
  getOrCreateMainAgentRuntime,
  getOrCreateScene,
  upsertAgentRuntimeSnapshot,
} from './agent-runtime-store.js'
import {
  MAIN_AGENT_ID,
  makeQqGroupSceneId,
  type SceneId,
} from './agent-runtime-types.js'
import type { GroupConversationBatch } from '../conversation/types.js'

export type RuntimeEventKind = 'group_message' | 'scheduler_tick' | 'manual_wake'

export interface PersistedGroupMessageIngress {
  [key: string]: unknown
  messageRowId: number
  messageId: number
  segments: ParsedSegment[]
}

export interface RuntimeEvent {
  [key: string]: unknown
  eventKind?: RuntimeEventKind
  createdAt: Date
  message?: PersistedGroupMessageIngress
}

export interface PersistedGroupMessageIngressOptions {
  executeDecisions?: boolean
  ingestSource?: BusinessLogIngestSource
}

export interface RuntimeEventOptions extends PersistedGroupMessageIngressOptions {}

export interface RootRuntimeManager {
  restore(groups: number[]): Promise<{ restoredCount: number }>
  emitRuntimeEvent(event: RuntimeEvent, options?: RuntimeEventOptions): Promise<void>
  ingestGroupMessage(input: PersistedGroupMessageIngress, options?: PersistedGroupMessageIngressOptions): Promise<void>
  getSnapshot(group: number): { lastObservedMessageRowId?: number; [key: string]: unknown } | null
  primeGroupCursor(input: Record<string, unknown>): Promise<void>
  requeuePendingPassiveMentions(groups?: number[]): number
  markPassiveReplyDelivered(input: Record<string, unknown>): Promise<void>
  dispatchPassiveMentionIfMentioned(input: Record<string, unknown>): boolean
  enqueuePassiveMention(event: unknown): void
  startPassiveExecution(): void
  stopPassiveExecution(): void
}

export interface RootRuntimeManagerOptions {
  [key: string]: unknown
  selfNumber: number
  now?: () => Date
  passiveWorker?: (batch: GroupConversationBatch) => Promise<any> | any
}

const snapshots = new Map<SceneId, Record<string, unknown>>()

function readSceneCursors(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const raw = (value as { sceneCursors?: unknown }).sceneCursors
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [sceneId, cursor] of Object.entries(raw)) {
    if (typeof cursor === 'number' && Number.isSafeInteger(cursor)) out[sceneId] = cursor
  }
  return out
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
}

function asDate(value: unknown, fallback: Date): Date {
  return value instanceof Date ? value : fallback
}

function asMessage(input: Record<string, unknown>): PersistedGroupMessageIngress | null {
  const message = input.message
  if (message && typeof message === 'object') return message as PersistedGroupMessageIngress
  return null
}

function isMentionedSelf(segments: ParsedSegment[], selfNumber: number): boolean {
  return segments.some((segment) => segment.type === 'at' && segment.targetId === String(selfNumber))
}

function buildReferencePayload(input: {
  messageRow: number
  message: number
  source: string
  idempotencyKey: string
}) {
  return {
    messageRowId: input.messageRow,
    messageId: input.message,
    ingestSource: input.source,
    source: 'messages',
    idempotencyKey: input.idempotencyKey,
  }
}

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const now = options.now ?? (() => new Date())

  async function materializeMessage(input: PersistedGroupMessageIngress, runtimeOptions: PersistedGroupMessageIngressOptions = {}) {
    const group = asNumber(input['groupId'])
    const messageRow = asNumber(input['messageRowId'])
    const message = asNumber(input['messageId'])
    const createdAt = asDate(input['createdAt'], now())
    const source = runtimeOptions.ingestSource ?? 'realtime'
    const sceneId = makeQqGroupSceneId(group)
    const idempotencyKey = `message:${messageRow}`
    const referencePayload = buildReferencePayload({ messageRow, message, source, idempotencyKey })

    await getOrCreateMainAgentRuntime()
    await getOrCreateScene({ kind: 'qq_group', externalId: group })
    const runtimeEvent = await createOrReuseRuntimeEvent({
      sceneId,
      eventType: 'group_message',
      payload: referencePayload,
      occurredAt: createdAt,
      idempotencyKey,
    })

    const mentioned = isMentionedSelf(input.segments, options.selfNumber)
    const opportunity = await createOrReuseOpportunity({
      sceneId,
      runtimeEventId: runtimeEvent.id,
      queueKind: mentioned ? 'obligation' : 'social',
      opportunityType: mentioned ? 'reply_to_mention' : 'ambient_candidate',
      priority: mentioned ? 100 : 1,
      payload: referencePayload,
      status: 'pending',
      idempotencyKey: `${idempotencyKey}:${mentioned ? 'reply' : 'ambient'}`,
    })

    const text = segmentsToPlainText(input.segments).trim()
    const shouldExecuteMention = mentioned && runtimeOptions.executeDecisions !== false && Boolean(options.passiveWorker)
    if (!shouldExecuteMention) {
      const suppressedMention = mentioned && runtimeOptions.executeDecisions === false
      const intent = await createOrReuseActionIntent({
        opportunityId: opportunity.id,
        actionType: mentioned && !suppressedMention ? 'reply_to_message' : 'artifact_only',
        targetSceneId: sceneId,
        payload: {
          ['groupId']: group,
          messageId: message,
          messageRowId: messageRow,
          text,
          opportunityType: mentioned ? 'reply_to_mention' : 'ambient_candidate',
        },
        dryRun: !mentioned || suppressedMention,
        riskLevel: mentioned ? 'medium' : 'low',
        status: mentioned && !suppressedMention ? 'pending' : 'suppressed',
        idempotencyKey: `${opportunity.id}:action`,
      })

      await createOrReuseActionRecord({
        actionIntentId: intent.id,
        actionType: intent.actionType as 'reply_to_message' | 'artifact_only',
        targetSceneId: sceneId,
        deliveryState: mentioned && !suppressedMention ? 'pending' : suppressedMention ? 'suppressed' : 'dry_run',
        idempotencyKey: intent.idempotencyKey,
        resultPayload: mentioned
          ? suppressedMention
            ? { reason: 'mention replay decisions disabled' }
            : null
          : { reason: 'ambient_candidate dryRun artifact-only' },
      })
    }

    const snapshot = {
      agentId: MAIN_AGENT_ID,
      schemaVersion: 1,
      contextSnapshot: {
        messages: [{ role: 'user', kind: 'group_message', orderKey: messageRow, senderId: asNumber(input['senderId']), content: text }],
      },
      sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: messageRow }, lastObservedMessageRowId: messageRow },
      lastObservedMessageRowId: messageRow,
      updatedAt: createdAt,
    }
    snapshots.set(sceneId, snapshot)
    await upsertAgentRuntimeSnapshot({
      contextSnapshot: snapshot.contextSnapshot,
      sessionSnapshot: snapshot.sessionSnapshot,
    })

    if (shouldExecuteMention && options.passiveWorker) {
      await options.passiveWorker({
        ['groupId']: group,
        events: [{
          ['groupId']: group,
          messageId: message,
          messageRowId: messageRow,
          senderId: asNumber(input['senderId']),
          createdAt: createdAt.getTime(),
        }],
        openedAt: createdAt.getTime(),
        closedAt: now().getTime(),
      })
    }
  }

  return {
    async restore(groups: number[]) {
      await getOrCreateMainAgentRuntime()
      const persisted = await getAgentRuntimeSnapshot()
      const sceneCursors = readSceneCursors(persisted?.sessionSnapshot)
      for (const group of groups) {
        await getOrCreateScene({ kind: 'qq_group', externalId: group })
        const sceneId = makeQqGroupSceneId(group)
        const cursor = sceneCursors[sceneId]
        if (cursor !== undefined) {
          snapshots.set(sceneId, {
            agentId: MAIN_AGENT_ID,
            schemaVersion: 1,
            contextSnapshot: { messages: [] },
            sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
            lastObservedMessageRowId: cursor,
          })
        }
      }
      return { restoredCount: groups.length }
    },
    async emitRuntimeEvent(event, runtimeOptions = {}) {
      if (event.eventKind !== 'group_message') return
      const message = asMessage(event)
      if (!message) return
      await materializeMessage(message, runtimeOptions)
    },
    async ingestGroupMessage(input, runtimeOptions = {}) {
      await materializeMessage(input, runtimeOptions)
    },
    getSnapshot(group) {
      return snapshots.get(makeQqGroupSceneId(group)) ?? null
    },
    async primeGroupCursor(input) {
      const group = asNumber(input['groupId'])
      const sceneId = makeQqGroupSceneId(group)
      const cursor = asNumber(input['lastObservedMessageRowId'])
      snapshots.set(sceneId, {
        agentId: MAIN_AGENT_ID,
        schemaVersion: 1,
        contextSnapshot: { messages: [] },
        sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
        lastObservedMessageRowId: cursor,
      })
      await upsertAgentRuntimeSnapshot({
        contextSnapshot: { messages: [] },
        sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
      })
    },
    requeuePendingPassiveMentions() {
      return 0
    },
    async markPassiveReplyDelivered() {},
    dispatchPassiveMentionIfMentioned() {
      return false
    },
    enqueuePassiveMention() {},
    startPassiveExecution() {},
    stopPassiveExecution() {},
  }
}

export function getGroupRuntimeKey(): string {
  return MAIN_AGENT_ID
}
