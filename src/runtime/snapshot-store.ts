import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import {
  createDefaultRootRuntimeSnapshot,
  MAIN_AGENT_ID,
  type AgentId,
  type CreateRootRuntimeSnapshotInput,
  type FocusTargetId,
  type ProactiveCandidateArtifact,
  type RootRuntimeContextSnapshot,
  type RootRuntimeSessionSnapshot,
  type RootRuntimeSnapshotRecord,
  type RuntimeContextMessage,
  type RuntimeCue,
  type RuntimeProactiveGenerationAttempt,
  type RuntimeSceneRecord,
} from './types.js'

const MAX_PROACTIVE_CANDIDATE_ARTIFACTS = 50

function sanitizeJsonValue(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item) ?? null)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, sanitizeJsonValue(item)] as const)
        .filter(([, item]) => item !== undefined),
    )
  }
  return String(value)
}

function isProactiveCandidateArtifact(item: unknown): item is ProactiveCandidateArtifact {
  if (!item || typeof item !== 'object') return false
  const artifact = item as Partial<ProactiveCandidateArtifact>
  return (
    artifact.artifactKind === 'proactive_candidate' &&
    typeof artifact.opportunityId === 'string' &&
    artifact.runtimeKey === MAIN_AGENT_ID &&
    typeof artifact.groupId === 'number' &&
    typeof artifact.sceneId === 'string' &&
    typeof artifact.createdAt === 'string' &&
    typeof artifact.expiresAt === 'string' &&
    typeof artifact.score === 'number' &&
    Array.isArray(artifact.gateReasons) &&
    typeof artifact.termination === 'string' &&
    (artifact.status === 'suppressed' || artifact.status === 'no_candidate' || artifact.status === 'candidate_generated')
  )
}

function isProactiveGenerationAttempt(item: unknown): item is RuntimeProactiveGenerationAttempt {
  if (!item || typeof item !== 'object') return false
  const attempt = item as Partial<RuntimeProactiveGenerationAttempt>
  return typeof attempt.opportunityId === 'string' && typeof attempt.attemptedAt === 'string'
}

function pruneProactiveCandidateArtifacts(artifacts: ProactiveCandidateArtifact[], now = new Date()): ProactiveCandidateArtifact[] {
  const nowMs = now.getTime()
  const latestByKey = new Map<string, ProactiveCandidateArtifact>()
  for (const artifact of artifacts) {
    const expiresAt = Date.parse(artifact.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) continue
    const key = `${artifact.runtimeKey}:${artifact.opportunityId}:${artifact.artifactKind}`
    const existing = latestByKey.get(key)
    if (!existing || artifact.createdAt.localeCompare(existing.createdAt) >= 0) latestByKey.set(key, artifact)
  }
  return [...latestByKey.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_PROACTIVE_CANDIDATE_ARTIFACTS)
}

function parseContextSnapshot(value: unknown): RootRuntimeContextSnapshot {
  if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray((value as { messages?: unknown }).messages)) {
    return { messages: [] }
  }
  const messages = (value as { messages: unknown[] }).messages.filter((message): message is RuntimeContextMessage => {
    if (!message || typeof message !== 'object') return false
    const candidate = message as Partial<RuntimeContextMessage>
    return (
      (candidate.role === 'user' || candidate.role === 'model') &&
      (candidate.kind === 'group_message' || candidate.kind === 'assistant_turn') &&
      typeof candidate.orderKey === 'number' &&
      Number.isInteger(candidate.orderKey) &&
      typeof candidate.senderId === 'number' &&
      Number.isInteger(candidate.senderId) &&
      typeof candidate.content === 'string'
    )
  })
  return { messages: messages.sort((a, b) => a.orderKey - b.orderKey || a.content.localeCompare(b.content)) }
}

function parseSessionSnapshot(value: unknown): RootRuntimeSessionSnapshot {
  const defaults = createDefaultRootRuntimeSnapshot().sessionSnapshot
  if (!value || typeof value !== 'object') return defaults
  const parsed = value as Partial<RootRuntimeSessionSnapshot>
  const focusedStateId = typeof parsed.focusedStateId === 'string' ? parsed.focusedStateId : 'portal'
  const stateStack = Array.isArray(parsed.stateStack) && parsed.stateStack.every((i) => typeof i === 'string') ? parsed.stateStack : [focusedStateId]
  const sceneRecords = Array.isArray(parsed.sceneRecords)
    ? parsed.sceneRecords.filter((item): item is RuntimeSceneRecord => {
        if (!item || typeof item !== 'object') return false
        const s = item as Partial<RuntimeSceneRecord>
        return typeof s.sceneId === 'string' && (s.kind === 'qq_group' || s.kind === 'qq_private') && typeof s.unreadCount === 'number'
      })
    : []
  const outstandingCues = Array.isArray(parsed.outstandingCues)
    ? parsed.outstandingCues.filter((item): item is RuntimeCue => Boolean(item && typeof item === 'object' && typeof (item as RuntimeCue).cueId === 'string'))
    : []
  return {
    focusedStateId,
    stateStack,
    focusedTargetId: parsed.focusedTargetId === 'portal' || typeof parsed.focusedTargetId === 'string' ? (parsed.focusedTargetId as FocusTargetId) : 'portal',
    unreadMessages: Array.isArray(parsed.unreadMessages) ? parsed.unreadMessages : [],
    senderContinuities: Array.isArray(parsed.senderContinuities) ? parsed.senderContinuities : [],
    ambientAuditCandidates: Array.isArray(parsed.ambientAuditCandidates) ? parsed.ambientAuditCandidates : [],
    sceneRecords,
    outstandingCues,
    proactiveCandidateArtifacts: pruneProactiveCandidateArtifacts(Array.isArray(parsed.proactiveCandidateArtifacts) ? parsed.proactiveCandidateArtifacts.filter(isProactiveCandidateArtifact) : []),
    proactiveGenerationAttempts: Array.isArray(parsed.proactiveGenerationAttempts) ? parsed.proactiveGenerationAttempts.filter(isProactiveGenerationAttempt) : [],
    recentObservedMessageRowIds: Array.isArray(parsed.recentObservedMessageRowIds) ? parsed.recentObservedMessageRowIds.filter((i): i is number => typeof i === 'number' && Number.isInteger(i)) : [],
    lastWakeAt: typeof parsed.lastWakeAt === 'string' || parsed.lastWakeAt === null ? parsed.lastWakeAt : null,
  }
}

type AgentRuntimeSnapshotRow = Awaited<ReturnType<typeof prisma.agentRuntimeSnapshot.findUnique>> extends infer T ? T extends null ? never : T : never

function mapRow(row: AgentRuntimeSnapshotRow): RootRuntimeSnapshotRecord {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    runtimeKey: MAIN_AGENT_ID,
    schemaVersion: row.schemaVersion,
    contextSnapshot: parseContextSnapshot(row.contextSnapshot),
    sessionSnapshot: parseSessionSnapshot(row.sessionSnapshot),
    groupId: 0,
    lastObservedMessageRowId: undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getRootRuntimeSnapshotByAgentId(agentId: AgentId = MAIN_AGENT_ID): Promise<RootRuntimeSnapshotRecord | null> {
  const row = await prisma.agentRuntimeSnapshot.findUnique({ where: { agentId } })
  return row ? mapRow(row) : null
}

export async function getRootRuntimeSnapshotByRuntimeKey(_runtimeKey: string): Promise<RootRuntimeSnapshotRecord | null> {
  return getRootRuntimeSnapshotByAgentId(MAIN_AGENT_ID)
}

export async function listRootRuntimeSnapshotsByAgentIds(agentIds: AgentId[] = [MAIN_AGENT_ID]): Promise<RootRuntimeSnapshotRecord[]> {
  const rows = await prisma.agentRuntimeSnapshot.findMany({ where: { agentId: { in: agentIds } }, orderBy: { updatedAt: 'desc' } })
  return rows.map(mapRow)
}

export async function listRootRuntimeSnapshotsByGroupIds(_groupIds: number[]): Promise<RootRuntimeSnapshotRecord[]> {
  const snapshot = await getRootRuntimeSnapshotByAgentId(MAIN_AGENT_ID)
  return snapshot ? [snapshot] : []
}

export async function upsertRootRuntimeSnapshot(input: CreateRootRuntimeSnapshotInput): Promise<RootRuntimeSnapshotRecord> {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const row = await prisma.agentRuntimeSnapshot.upsert({
    where: { agentId },
    create: {
      agentId,
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) as Prisma.InputJsonObject,
      sessionSnapshot: sanitizeJsonValue(input.sessionSnapshot) as Prisma.InputJsonObject,
    },
    update: {
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) as Prisma.InputJsonObject,
      sessionSnapshot: sanitizeJsonValue(input.sessionSnapshot) as Prisma.InputJsonObject,
    },
  })
  return mapRow(row)
}
