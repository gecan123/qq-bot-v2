import type { Prisma } from '../generated/prisma/client.js'
import {
  buildFeedItemReferencePayload,
  createOrReuseActionIntent,
  createOrReuseActionRecord,
  createOrReuseDecision,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  getOrCreateMainAgentRuntime,
  getOrCreateScene,
  markActionRecordDeliveryState,
} from '../runtime/agent-runtime-store.js'
import { makeSceneId, type SceneId } from '../runtime/agent-runtime-types.js'
import {
  createOrReuseRationaleArtifact,
  createOrReuseReadSession,
  createOrReuseSourceSummary,
  createOrReuseThoughtArtifact,
  upsertFeedItem,
  upsertFeedSource,
} from './forum-read-store.js'
import { buildForumReadIdempotencyKey } from './forum-read-versioning.js'

const FORUM_POLICY_VERSION = 'runtime-os.phase4.forum-readonly.v1'
const FORUM_ALLOWED_ACTIONS = ['read_forum_post', 'artifact_only'] as const
const FORUM_FORBIDDEN_ACTIONS = ['reply', 'comment', 'like', 'public_outbound'] as const

export interface ForumReadSourceInput {
  kind: string
  externalId: string
  displayName?: string | null
  config?: Record<string, unknown> | null
}

export interface ForumReadItemInput {
  externalId: string
  url?: string | null
  title: string
  author?: string | null
  rawContent?: string | null
  publishedAt?: Date | null
  seenAt?: Date
}

export interface ForumReadInput {
  source: ForumReadSourceInput
  item: ForumReadItemInput
  selectionReason: string
  now?: Date
}

export interface ForumReadResult {
  sceneId: SceneId
  feedSourceId: string
  feedItemId: string
  runtimeEventId: string
  opportunityId: string
  decisionId: string
  actionIntentId: string
  actionRecordId: string
  readSessionId: string
  sourceSummaryId: string
  thoughtArtifactId: string
  rationaleArtifactId: string
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function buildSummary(input: ForumReadItemInput): string {
  const body = input.rawContent?.trim()
  if (body) return clip(`${input.title}: ${body}`, 420)
  return clip(input.title, 420)
}

function buildThought(input: { title: string; summary: string }): string {
  return clip(`这个帖子可能值得后续观察：${input.title}。当前只记录为兴趣线索，不作为事实定论。${input.summary}`, 420)
}

function buildRationale(input: { selectionReason: string; sourceKind: string }): string {
  return clip(`选择原因：${input.selectionReason}。来源类型：${input.sourceKind}。本次执行只读，不进行回复、评论、点赞或公开外发。`, 420)
}

function buildReference(input: {
  feedSourceId: string
  feedItemId: string
  contentHash?: string | null
  idempotencyKey: string
}): Prisma.JsonObject {
  return buildFeedItemReferencePayload(input) as Prisma.JsonObject
}

export async function ingestAndReadForumItem(input: ForumReadInput): Promise<ForumReadResult> {
  const now = input.now ?? new Date()
  const sceneExternalId = `${input.source.kind}:${input.source.externalId}`
  const sceneId = makeSceneId('forum', sceneExternalId)

  await getOrCreateMainAgentRuntime()
  await getOrCreateScene({
    kind: 'forum',
    externalId: sceneExternalId,
    displayName: input.source.displayName ?? input.source.externalId,
    policy: {
      outbound: 'disabled',
      allowedActions: [...FORUM_ALLOWED_ACTIONS],
    },
  })

  const feedSource = await upsertFeedSource({
    sceneId,
    kind: input.source.kind,
    externalId: input.source.externalId,
    displayName: input.source.displayName,
    config: input.source.config,
  })
  const feedItem = await upsertFeedItem({
    feedSourceId: feedSource.id,
    externalId: input.item.externalId,
    url: input.item.url,
    title: input.item.title,
    author: input.item.author,
    rawContent: input.item.rawContent,
    publishedAt: input.item.publishedAt,
    seenAt: input.item.seenAt ?? now,
  })

  const contentHash = feedItem.contentHash ?? 'no-content-hash'
  const idempotencyKey = buildForumReadIdempotencyKey(feedItem.id, contentHash)
  const referencePayload = buildReference({
    feedSourceId: feedSource.id,
    feedItemId: feedItem.id,
    contentHash,
    idempotencyKey,
  })
  const runtimeEvent = await createOrReuseRuntimeEvent({
    sceneId,
    eventType: 'forum_item_seen',
    payload: referencePayload,
    occurredAt: now,
    idempotencyKey,
  })
  const opportunity = await createOrReuseOpportunity({
    sceneId,
    runtimeEventId: runtimeEvent.id,
    queueKind: 'curiosity',
    opportunityType: 'read_forum_post',
    priority: 10,
    payload: referencePayload,
    status: 'pending',
    idempotencyKey: `${idempotencyKey}:read`,
  })
  const decision = await createOrReuseDecision({
    opportunityId: opportunity.id,
    idempotencyKey: `${opportunity.id}:policy`,
    policyVersion: FORUM_POLICY_VERSION,
    verdict: 'approved',
    actionType: 'read_forum_post',
    riskLevel: 'L1',
    reason: 'read-only forum curiosity item may be summarized into local artifacts only',
    barrierInput: {
      sourceRefs: referencePayload,
      actionType: 'read_forum_post',
      riskLevel: 'L1',
    },
    barrierOutput: {
      verdict: 'approved',
      allowedActions: [...FORUM_ALLOWED_ACTIONS],
      forbiddenActions: [...FORUM_FORBIDDEN_ACTIONS],
      reason: 'forum curiosity scene is read-only',
    },
  })
  const actionIntent = await createOrReuseActionIntent({
    opportunityId: opportunity.id,
    decisionId: decision.id,
    actionType: 'read_forum_post',
    targetSceneId: sceneId,
    payload: {
      sourceRefs: referencePayload,
      proposedEffect: {
        type: 'read_forum_post',
        generatedTextStatus: 'deferred',
      },
    },
    dryRun: false,
    riskLevel: 'L1',
    status: 'approved',
    idempotencyKey: `${opportunity.id}:read_forum_post`,
  })
  const actionRecord = await createOrReuseActionRecord({
    actionIntentId: actionIntent.id,
    actionType: 'read_forum_post',
    targetSceneId: sceneId,
    deliveryState: 'pending',
    idempotencyKey: actionIntent.idempotencyKey,
    resultPayload: {
      sourceRefs: referencePayload,
      status: 'read_started',
    },
  })

  const summary = buildSummary(input.item)
  const readSession = await createOrReuseReadSession({
    feedItemId: feedItem.id,
    contentHash,
    opportunityId: opportunity.id,
    actionRecordId: actionRecord.id,
    selectionReason: input.selectionReason,
    status: 'completed',
    startedAt: now,
    completedAt: now,
  })
  const sourceSummary = await createOrReuseSourceSummary({
    readSessionId: readSession.id,
    summary,
  })
  const thoughtArtifact = await createOrReuseThoughtArtifact({
    readSessionId: readSession.id,
    thought: buildThought({ title: input.item.title, summary }),
  })
  const rationaleArtifact = await createOrReuseRationaleArtifact({
    readSessionId: readSession.id,
    rationale: buildRationale({ selectionReason: input.selectionReason, sourceKind: input.source.kind }),
  })

  await markActionRecordDeliveryState(actionRecord.id, 'sent', {
    sourceRefs: referencePayload,
    contentHash,
    readSessionId: readSession.id,
    summary,
    thoughtArtifactId: thoughtArtifact.id,
    rationaleArtifactId: rationaleArtifact.id,
    memoryGovernanceStarted: false,
    readOnly: true,
    forbiddenActions: [...FORUM_FORBIDDEN_ACTIONS],
  })

  return {
    sceneId,
    feedSourceId: feedSource.id,
    feedItemId: feedItem.id,
    runtimeEventId: runtimeEvent.id,
    opportunityId: opportunity.id,
    decisionId: decision.id,
    actionIntentId: actionIntent.id,
    actionRecordId: actionRecord.id,
    readSessionId: readSession.id,
    sourceSummaryId: sourceSummary.id,
    thoughtArtifactId: thoughtArtifact.id,
    rationaleArtifactId: rationaleArtifact.id,
  }
}
