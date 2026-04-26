import { createHash } from 'node:crypto'
import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import { computeForumItemContentHash } from './forum-read-versioning.js'

export { computeForumItemContentHash } from './forum-read-versioning.js'

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item) ?? null)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item) ?? null]))
  }
  return String(value)
}

export interface ForumSourceInput {
  sceneId: string
  kind: string
  externalId: string
  displayName?: string | null
  config?: Record<string, unknown> | null
}

export interface ForumItemInput {
  feedSourceId: string
  externalId: string
  url?: string | null
  title: string
  author?: string | null
  rawContent?: string | null
  publishedAt?: Date | null
  seenAt?: Date
}

export async function upsertFeedSource(input: ForumSourceInput) {
  const id = stableId('feed-source', `${input.kind}:${input.externalId}`)
  return prisma.feedSource.upsert({
    where: { kind_externalId: { kind: input.kind, externalId: input.externalId } },
    update: {
      sceneId: input.sceneId,
      displayName: input.displayName ?? undefined,
      config: input.config === undefined ? undefined : sanitizeJsonValue(input.config) as Prisma.InputJsonObject,
      status: 'active',
    },
    create: {
      id,
      sceneId: input.sceneId,
      kind: input.kind,
      externalId: input.externalId,
      displayName: input.displayName ?? null,
      config: input.config == null ? undefined : sanitizeJsonValue(input.config) as Prisma.InputJsonObject,
      status: 'active',
    },
  })
}

export async function upsertFeedItem(input: ForumItemInput) {
  const contentHash = computeForumItemContentHash(input)
  const id = stableId('feed-item', `${input.feedSourceId}:${input.externalId}`)
  return prisma.feedItem.upsert({
    where: { feedSourceId_externalId: { feedSourceId: input.feedSourceId, externalId: input.externalId } },
    update: {
      url: input.url ?? null,
      title: input.title,
      author: input.author ?? null,
      rawContent: input.rawContent ?? null,
      contentHash,
      publishedAt: input.publishedAt ?? undefined,
      seenAt: input.seenAt ?? undefined,
    },
    create: {
      id,
      feedSourceId: input.feedSourceId,
      externalId: input.externalId,
      url: input.url ?? null,
      title: input.title,
      author: input.author ?? null,
      rawContent: input.rawContent ?? null,
      contentHash,
      publishedAt: input.publishedAt ?? null,
      seenAt: input.seenAt ?? new Date(),
    },
  })
}

export async function createOrReuseReadSession(input: {
  feedItemId: string
  contentHash?: string | null
  opportunityId: string
  actionRecordId?: string | null
  selectionReason: string
  status?: string
  startedAt?: Date
  completedAt?: Date | null
}) {
  const id = stableId('read-session', `${input.feedItemId}:${input.opportunityId}:${input.contentHash ?? 'no-content-hash'}`)
  return prisma.readSession.upsert({
    where: { id },
    update: {
      actionRecordId: input.actionRecordId ?? undefined,
      status: input.status ?? undefined,
      completedAt: input.completedAt ?? undefined,
    },
    create: {
      id,
      feedItemId: input.feedItemId,
      contentHash: input.contentHash ?? null,
      opportunityId: input.opportunityId,
      actionRecordId: input.actionRecordId ?? null,
      selectionReason: input.selectionReason,
      status: input.status ?? 'completed',
      startedAt: input.startedAt ?? new Date(),
      completedAt: input.completedAt ?? new Date(),
    },
  })
}

export async function createOrReuseSourceSummary(input: {
  readSessionId: string
  summary: string
}) {
  const id = stableId('source-summary', input.readSessionId)
  return prisma.sourceSummary.upsert({
    where: { id },
    update: {},
    create: {
      id,
      readSessionId: input.readSessionId,
      summary: input.summary,
    },
  })
}

export async function createOrReuseThoughtArtifact(input: {
  readSessionId: string
  thought: string
}) {
  const id = stableId('thought-artifact', input.readSessionId)
  return prisma.thoughtArtifact.upsert({
    where: { id },
    update: {},
    create: {
      id,
      readSessionId: input.readSessionId,
      thought: input.thought,
    },
  })
}

export async function createOrReuseRationaleArtifact(input: {
  readSessionId: string
  rationale: string
}) {
  const id = stableId('rationale-artifact', input.readSessionId)
  return prisma.rationaleArtifact.upsert({
    where: { id },
    update: {},
    create: {
      id,
      readSessionId: input.readSessionId,
      rationale: input.rationale,
    },
  })
}
