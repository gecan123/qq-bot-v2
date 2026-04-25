import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import type {
  CreateRootRuntimeSnapshotInput,
  FocusTargetId,
  RootRuntimeContextSnapshot,
  RuntimeCue,
  RuntimeContextMessage,
  RuntimeProactiveGenerationAttempt,
  RuntimeSceneRecord,
  RootRuntimeSessionSnapshot,
  RootRuntimeSnapshotRecord,
  ProactiveCandidateArtifact,
} from './types.js'

const MAX_PROACTIVE_CANDIDATE_ARTIFACTS = 50

function isProactiveCandidateArtifact(item: unknown): item is ProactiveCandidateArtifact {
  if (!item || typeof item !== 'object') return false
  const artifact = item as Partial<ProactiveCandidateArtifact>
  return (
    artifact.artifactKind === 'proactive_candidate' &&
    typeof artifact.opportunityId === 'string' &&
    typeof artifact.runtimeKey === 'string' &&
    typeof artifact.groupId === 'number' &&
    typeof artifact.sceneId === 'string' &&
    typeof artifact.sourceKind === 'string' &&
    typeof artifact.triggerMessageRowId === 'number' &&
    typeof artifact.incorporatedMessageRowId === 'number' &&
    typeof artifact.createdAt === 'string' &&
    typeof artifact.expiresAt === 'string' &&
    typeof artifact.score === 'number' &&
    Array.isArray(artifact.gateReasons) &&
    artifact.gateReasons.every((reason) => typeof reason === 'string') &&
    typeof artifact.termination === 'string' &&
    (artifact.status === 'suppressed' || artifact.status === 'no_candidate' || artifact.status === 'candidate_generated') &&
    (artifact.candidateText === undefined || typeof artifact.candidateText === 'string') &&
    (artifact.model === undefined || typeof artifact.model === 'string')
  )
}

function isProactiveGenerationAttempt(item: unknown): item is RuntimeProactiveGenerationAttempt {
  if (!item || typeof item !== 'object') return false
  const attempt = item as Partial<RuntimeProactiveGenerationAttempt>
  return typeof attempt.opportunityId === 'string' && typeof attempt.attemptedAt === 'string'
}

function pruneProactiveCandidateArtifacts(
  artifacts: ProactiveCandidateArtifact[],
  now = new Date(),
): ProactiveCandidateArtifact[] {
  const nowMs = now.getTime()
  const latestByKey = new Map<string, ProactiveCandidateArtifact>()

  for (const artifact of artifacts) {
    const expiresAt = Date.parse(artifact.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) continue

    const key = `${artifact.runtimeKey}:${artifact.opportunityId}:${artifact.artifactKind}`
    const existing = latestByKey.get(key)
    if (!existing || artifact.createdAt.localeCompare(existing.createdAt) >= 0) {
      latestByKey.set(key, artifact)
    }
  }

  return [...latestByKey.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_PROACTIVE_CANDIDATE_ARTIFACTS)
}

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item) ?? null)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, sanitizeJsonValue(item)] as const)
      .filter(([, item]) => item !== undefined)

    return Object.fromEntries(entries)
  }

  return String(value)
}

function parseContextSnapshot(value: unknown): RootRuntimeContextSnapshot {
  if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages)) {
    return { messages: [] }
  }

  const messages = value.messages.filter((message): message is RuntimeContextMessage => {
    if (!message || typeof message !== 'object') {
      return false
    }

    return (
      (message.role === 'user' || message.role === 'model') &&
      (message.kind === 'group_message' || message.kind === 'assistant_turn') &&
      typeof message.orderKey === 'number' &&
      Number.isInteger(message.orderKey) &&
      typeof message.senderId === 'number' &&
      Number.isInteger(message.senderId) &&
      typeof message.content === 'string'
    )
  })

  return {
    messages: messages.sort((left, right) => {
      if (left.orderKey !== right.orderKey) {
        return left.orderKey - right.orderKey
      }

      if (left.kind !== right.kind) {
        return left.kind === 'group_message' ? -1 : 1
      }

      if (left.senderId !== right.senderId) {
        return left.senderId - right.senderId
      }

      return left.content.localeCompare(right.content)
    }),
  }
}

function parseSessionSnapshot(value: unknown): RootRuntimeSessionSnapshot {
  if (!value || typeof value !== 'object') {
    return {
      focusedStateId: 'portal',
      stateStack: ['portal'],
      focusedTargetId: 'portal',
      unreadMessages: [],
      senderContinuities: [],
      ambientAuditCandidates: [],
      sceneRecords: [],
      outstandingCues: [],
      proactiveCandidateArtifacts: [],
      proactiveGenerationAttempts: [],
      recentObservedMessageRowIds: [],
      lastWakeAt: null,
    }
  }

  const parsed = value as Partial<RootRuntimeSessionSnapshot>
  const legacyParsed = value as Record<string, unknown>
  const focusedStateId = typeof parsed.focusedStateId === 'string' ? parsed.focusedStateId : 'portal'
  const focusedTargetId =
    parsed.focusedTargetId === 'portal' || typeof parsed.focusedTargetId === 'string'
      ? (parsed.focusedTargetId as FocusTargetId)
      : (focusedStateId as FocusTargetId)
  const stateStack = Array.isArray(parsed.stateStack) && parsed.stateStack.every((item) => typeof item === 'string')
    ? parsed.stateStack
    : [focusedStateId]
  const sceneRecords = Array.isArray(parsed.sceneRecords)
    ? parsed.sceneRecords.filter((item): item is RuntimeSceneRecord => {
        if (!item || typeof item !== 'object') return false
        return (
          typeof item.sceneId === 'string' &&
          (item.kind === 'qq_group' || item.kind === 'qq_private') &&
          (item.groupId === undefined || (typeof item.groupId === 'number' && Number.isInteger(item.groupId))) &&
          typeof item.unreadCount === 'number' &&
          Number.isInteger(item.unreadCount) &&
          (item.lastObservedMessageRowId === null ||
            (typeof item.lastObservedMessageRowId === 'number' && Number.isInteger(item.lastObservedMessageRowId))) &&
          (item.lastMaterializedReplyRowId === null ||
            (typeof item.lastMaterializedReplyRowId === 'number' &&
              Number.isInteger(item.lastMaterializedReplyRowId))) &&
          (item.lastFocusedAt === null || typeof item.lastFocusedAt === 'string') &&
          (item.lastSpokeAt === null || typeof item.lastSpokeAt === 'string') &&
          Array.isArray(item.outstandingCueIds) &&
          item.outstandingCueIds.every((cueId) => typeof cueId === 'string')
        )
      })
    : []
  const outstandingCues = Array.isArray(parsed.outstandingCues)
    ? parsed.outstandingCues.filter((item): item is RuntimeCue => {
        if (!item || typeof item !== 'object') return false
        return (
          typeof item.cueId === 'string' &&
          typeof item.sceneId === 'string' &&
          item.cueKind === 'message' &&
          typeof item.triggerMessageRowId === 'number' &&
          Number.isInteger(item.triggerMessageRowId) &&
          typeof item.messageId === 'number' &&
          Number.isInteger(item.messageId) &&
          typeof item.senderId === 'number' &&
          Number.isInteger(item.senderId) &&
          typeof item.senderNickname === 'string' &&
          typeof item.addressedToAgent === 'boolean' &&
          (item.cueStrength === 'weak' || item.cueStrength === 'strong') &&
          (item.replyModeHint === 'anchored' || item.replyModeHint === 'unanchored') &&
          (item.preferredDeliveryMode === 'reply_to_message' || item.preferredDeliveryMode === 'send_message') &&
          typeof item.mustReplyOverride === 'boolean' &&
          ['pending', 'suppressed', 'refused', 'replied', 'delivery_failed'].includes(item.status) &&
          typeof item.createdAt === 'string'
        )
      })
    : []

  return {
    focusedStateId,
    stateStack,
    focusedTargetId,
    unreadMessages: Array.isArray(parsed.unreadMessages) ? parsed.unreadMessages : [],
    senderContinuities: Array.isArray(parsed.senderContinuities) ? parsed.senderContinuities : [],
    ambientAuditCandidates: Array.isArray(parsed.ambientAuditCandidates)
      ? parsed.ambientAuditCandidates
      : Array.isArray(legacyParsed['proactive' + 'Candidates'])
        ? (legacyParsed['proactive' + 'Candidates'] as RootRuntimeSessionSnapshot['ambientAuditCandidates'])
        : [],
    proactiveCandidateArtifacts: pruneProactiveCandidateArtifacts(
      Array.isArray(parsed.proactiveCandidateArtifacts)
        ? parsed.proactiveCandidateArtifacts.filter(isProactiveCandidateArtifact)
        : [],
    ),
    proactiveGenerationAttempts: Array.isArray(parsed.proactiveGenerationAttempts)
      ? parsed.proactiveGenerationAttempts.filter(isProactiveGenerationAttempt)
      : [],
    sceneRecords,
    outstandingCues,
    recentObservedMessageRowIds: Array.isArray(parsed.recentObservedMessageRowIds)
      ? parsed.recentObservedMessageRowIds.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
      : [],
    lastWakeAt: typeof parsed.lastWakeAt === 'string' || parsed.lastWakeAt === null ? (parsed.lastWakeAt ?? null) : null,
  }
}

function mapRow(
  row: Awaited<ReturnType<typeof prisma.agentRuntimeSnapshot.findUnique>> extends infer T
    ? T extends null ? never : T
    : never,
): RootRuntimeSnapshotRecord {
  const sessionSnapshot = parseSessionSnapshot(row.sessionSnapshot)
  return {
    id: row.id,
    runtimeKey: row.agentId,
    groupId: 0,
    schemaVersion: row.schemaVersion,
    contextSnapshot: parseContextSnapshot(row.contextSnapshot),
    sessionSnapshot,
    lastObservedMessageRowId:
      typeof (sessionSnapshot as unknown as { lastObservedMessageRowId?: unknown }).lastObservedMessageRowId === 'number'
        ? (sessionSnapshot as unknown as { lastObservedMessageRowId: number }).lastObservedMessageRowId
        : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listRootRuntimeSnapshotsByGroupIds(groupIds: number[]): Promise<RootRuntimeSnapshotRecord[]> {
  if (groupIds.length === 0) return []

  const rows = await prisma.agentRuntimeSnapshot.findMany({
    where: { agentId: 'agent:main' },
    orderBy: { updatedAt: 'desc' },
  })

  return rows.map((row) => mapRow(row))
}

export async function getRootRuntimeSnapshotByRuntimeKey(runtimeKey: string): Promise<RootRuntimeSnapshotRecord | null> {
  const row = await prisma.agentRuntimeSnapshot.findUnique({
    where: { agentId: runtimeKey },
  })

  return row ? mapRow(row) : null
}

export async function upsertRootRuntimeSnapshot(
  input: CreateRootRuntimeSnapshotInput,
): Promise<RootRuntimeSnapshotRecord> {
  const sessionSnapshot = {
    ...input.sessionSnapshot,
    proactiveCandidateArtifacts: pruneProactiveCandidateArtifacts(
      input.sessionSnapshot.proactiveCandidateArtifacts ?? [],
    ),
    proactiveGenerationAttempts: input.sessionSnapshot.proactiveGenerationAttempts ?? [],
  }
  const row = await prisma.agentRuntimeSnapshot.upsert({
    where: {
      agentId: input.runtimeKey,
    },
    create: {
      agentId: input.runtimeKey,
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) ?? { messages: [] },
      sessionSnapshot: sanitizeJsonValue(sessionSnapshot) ?? {},
    },
    update: {
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) ?? { messages: [] },
      sessionSnapshot: sanitizeJsonValue(sessionSnapshot) ?? {},
    },
  })

  return mapRow(row)
}
