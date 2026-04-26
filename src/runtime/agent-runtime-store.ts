import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import {
  AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  MAIN_AGENT_ID,
  makeSceneId,
  type AgentId,
  type ActionDeliveryState,
  type ActionIntentStatus,
  type ActionRecord,
  type ActionType,
  type Decision,
  type DecisionVerdict,
  type MemoryAutoAcceptPolicy,
  type MemoryItem,
  type MemoryProposal,
  type MemoryType,
  type OpportunityType,
  type QueueKind,
  type ReferencePayload,
  type RiskLevel,
  type RuntimeEventRecord,
  type RuntimeEventType,
  type SceneId,
  type SceneKind,
  type SelfSpineUpdateProposal,
  type SelfSpineVersion,
} from './agent-runtime-types.js'

export const MEMORY_TYPES: readonly MemoryType[] = [
  'observation',
  'fact',
  'hypothesis',
  'interest',
  'preference',
  'commitment',
  'reflection',
  'relationship',
]

const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPES)
const DEFAULT_MEMORY_AUTO_ACCEPT_POLICY: Required<Pick<MemoryAutoAcceptPolicy, 'allowedTypes' | 'maxSalience' | 'minConfidence'>> = {
  allowedTypes: ['observation'],
  maxSalience: 0.35,
  minConfidence: 0.65,
}
const SELF_SPINE_SECTIONS = new Set([
  'identity',
  'expression_style',
  'long_term_interests',
  'values',
  'tool_boundaries',
  'long_term_goals',
  'important_memory_summary',
  'scene_preferences',
  'prohibitions',
])

const ALLOWED_REFERENCE_KEYS = new Set([
  'messageRowId',
  'messageId',
  'feedSourceId',
  'feedItemId',
  'contentHash',
  'readSessionId',
  'actionRecordId',
  'ingestSource',
  'source',
  'idempotencyKey',
])
const FORBIDDEN_REFERENCE_KEYS = new Set([
  'segments',
  'plainText',
  'content',
  'text',
  'rawContent',
  'rawMessage',
  'senderNickname',
  'senderGroupNickname',
  'mediaDescriptions',
  'resolvedText',
])
const FORBIDDEN_INBOUND_COPY_KEYS = new Set([
  ...FORBIDDEN_REFERENCE_KEYS,
  'senderId',
])

function makeId(prefix: string, key: string): string {
  return `${prefix}:${Buffer.from(key).toString('base64url').slice(0, 96)}`
}

function asJsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {}
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asJsonObjectOrNull(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : null
}

function mergeStringLists(...lists: unknown[]): string[] {
  const merged = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string' && item) merged.add(item)
    }
  }
  return [...merged]
}

export function mergeRuntimeSessionSnapshot(
  existing: Prisma.JsonObject | null | undefined,
  next: Prisma.JsonObject,
): Prisma.JsonObject {
  const existingSnapshot = asRecord(existing)
  const nextSnapshot = asRecord(next)
  const existingCursors = asRecord(existingSnapshot.sceneCursors)
  const nextCursors = asRecord(nextSnapshot.sceneCursors)
  return {
    ...existingSnapshot,
    ...nextSnapshot,
    scenes: mergeStringLists(existingSnapshot.scenes, nextSnapshot.scenes),
    sceneCursors: {
      ...existingCursors,
      ...nextCursors,
    } as Prisma.JsonObject,
  }
}

function toReferencePayload(payload: ReferencePayload): Prisma.JsonObject {
  const out: Prisma.JsonObject = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key) || FORBIDDEN_REFERENCE_KEYS.has(key)) {
      throw new Error(`runtime reference payload contains unsupported key: ${key}`)
    }
    out[key] = value
  }
  return out
}

export function assertReferenceOnlyPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key) || FORBIDDEN_REFERENCE_KEYS.has(key)) {
      throw new Error(`runtime payload must be reference-only; forbidden key: ${key}`)
    }
  }
}

function assertNoForbiddenInboundCopies(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenInboundCopies(item, `${path}[${index}]`))
    return
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'text' && path.endsWith('proposedEffect')) {
      continue
    }
    if (FORBIDDEN_INBOUND_COPY_KEYS.has(key)) {
      throw new Error(`runtime payload must not copy inbound user facts; forbidden key: ${path}.${key}`)
    }
    assertNoForbiddenInboundCopies(nested, `${path}.${key}`)
  }
}

export function assertRuntimeSnapshotReferenceOnly(contextSnapshot: Prisma.JsonObject): void {
  assertNoForbiddenInboundCopies(contextSnapshot, 'contextSnapshot')
}

export function assertActionIntentPayloadSafe(payload: Prisma.JsonObject): void {
  assertNoForbiddenInboundCopies(payload, 'actionIntent.payload')
}

export function buildMessageReferencePayload(input: {
  messageRowId: number
  messageId: number
  ingestSource?: string
  source?: string
  idempotencyKey: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messageRowId: input.messageRowId,
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
  }
  if (input.ingestSource) payload.ingestSource = input.ingestSource
  if (input.source) payload.source = input.source
  assertReferenceOnlyPayload(payload)
  return payload
}

export function buildFeedItemReferencePayload(input: {
  feedSourceId: string
  feedItemId: string
  contentHash?: string | null
  idempotencyKey: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    feedSourceId: input.feedSourceId,
    feedItemId: input.feedItemId,
    source: 'feed_items',
    idempotencyKey: input.idempotencyKey,
  }
  if (input.contentHash) payload.contentHash = input.contentHash
  assertReferenceOnlyPayload(payload)
  return payload
}

export function assertMemoryType(proposalType: string): asserts proposalType is MemoryType {
  if (!MEMORY_TYPE_SET.has(proposalType)) {
    throw new Error(`unsupported memory type: ${proposalType}`)
  }
}

export function canAutoAcceptMemoryProposal(
  proposal: { proposalType: string; confidence?: number | null; salience?: number | null },
  policy: MemoryAutoAcceptPolicy,
): boolean {
  if (!policy.enabled) return false
  assertMemoryType(proposal.proposalType)
  if (proposal.proposalType !== 'observation') return false

  const allowedTypes = policy.allowedTypes ?? DEFAULT_MEMORY_AUTO_ACCEPT_POLICY.allowedTypes
  if (!allowedTypes.includes(proposal.proposalType)) return false

  const maxSalience = policy.maxSalience ?? DEFAULT_MEMORY_AUTO_ACCEPT_POLICY.maxSalience
  const minConfidence = policy.minConfidence ?? DEFAULT_MEMORY_AUTO_ACCEPT_POLICY.minConfidence
  if ((proposal.salience ?? 1) > maxSalience) return false
  if ((proposal.confidence ?? 0) < minConfidence) return false
  return true
}

function assertSelfSpinePatch(patch: Prisma.JsonObject): void {
  const sections = Object.keys(patch)
  if (sections.length === 0) throw new Error('self spine patch must include at least one section')
  for (const section of sections) {
    if (!SELF_SPINE_SECTIONS.has(section)) {
      throw new Error(`unsupported self spine section: ${section}`)
    }
  }
}

function sourceRefsFrom(sourceRef: Prisma.JsonObject): Prisma.JsonObject[] {
  const refs = sourceRef.sourceRefs
  if (!Array.isArray(refs)) return []
  return refs.filter((ref): ref is Prisma.JsonObject => Boolean(ref) && typeof ref === 'object' && !Array.isArray(ref))
}

function sourceIdentity(ref: Prisma.JsonObject): string | null {
  if (ref.messageRowId !== undefined) return `messageRowId:${String(ref.messageRowId)}`
  if (ref.messageId !== undefined) return `messageId:${String(ref.messageId)}`
  if (ref.feedItemId !== undefined) return `feedItemId:${String(ref.feedItemId)}`
  if (ref.actionRecordId !== undefined) return `actionRecordId:${String(ref.actionRecordId)}`
  if (ref.readSessionId !== undefined) return `readSessionId:${String(ref.readSessionId)}`
  return null
}

function distinctSourceRefCount(refs: Prisma.JsonObject[]): number {
  const identities = new Set<string>()
  for (const ref of refs) {
    const identity = sourceIdentity(ref)
    if (identity) identities.add(identity)
  }
  return identities.size
}

export function assertSelfSpineSourceCanMutate(sourceRef: Prisma.JsonObject): void {
  const basis = typeof sourceRef.basis === 'string' ? sourceRef.basis : ''
  if (basis === 'single_message' || basis === 'single_forum_post') {
    throw new Error(`single-source ${basis} must not directly mutate Self Spine`)
  }

  const refs = sourceRefsFrom(sourceRef)
  const distinctRefCount = distinctSourceRefCount(refs)
  if (basis === 'aggregate_review' && distinctRefCount < 2) {
    throw new Error('aggregate Self Spine update requires multiple distinct source refs')
  }
  if (refs.length === 0 && basis !== 'manual_review' && basis !== 'maintenance_review') {
    throw new Error('self spine update requires review basis or aggregate source refs')
  }
  if (distinctRefCount !== 1) return

  const onlyRef = refs[0] ?? {}
  const explicitReviewBasis = basis === 'manual_review' || basis === 'maintenance_review' || basis === 'aggregate_review'
  const directMessageRef = onlyRef.messageRowId !== undefined || onlyRef.messageId !== undefined
  const directForumRef = onlyRef.feedItemId !== undefined
  if (!explicitReviewBasis && (directMessageRef || directForumRef)) {
    throw new Error('single message or single forum post must not directly mutate Self Spine')
  }
}

function mergeJsonPatch(base: Prisma.JsonObject, patch: Prisma.JsonObject): Prisma.JsonObject {
  const out: Prisma.JsonObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = mergeJsonPatch(existing as Prisma.JsonObject, value as Prisma.JsonObject)
    } else {
      out[key] = value
    }
  }
  return out
}

function memoryProposalFromRow(row: {
  id: string
  agentId: string
  sourceRef: Prisma.JsonValue
  proposalType: string
  payload: Prisma.JsonValue
  confidence: number | null
  salience: number | null
  status: string
  decayPolicy?: Prisma.JsonValue | null
  expiresAt?: Date | null
  idempotencyKey: string
  createdAt: Date
  updatedAt: Date
}): MemoryProposal {
  assertMemoryType(row.proposalType)
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    sourceRef: asJsonObject(row.sourceRef),
    proposalType: row.proposalType,
    payload: asJsonObject(row.payload),
    confidence: row.confidence,
    salience: row.salience,
    status: row.status as MemoryProposal['status'],
    decayPolicy: asJsonObjectOrNull(row.decayPolicy ?? null),
    expiresAt: row.expiresAt ?? null,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function memoryItemFromRow(row: {
  id: string
  agentId: string
  scope: string
  memoryType: string
  sourceRef: Prisma.JsonValue
  sourceProposalId: string | null
  payload: Prisma.JsonValue
  confidence: number | null
  salience: number | null
  status: string
  decayPolicy?: Prisma.JsonValue | null
  expiresAt?: Date | null
  acceptedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}): MemoryItem {
  assertMemoryType(row.memoryType)
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    scope: row.scope,
    memoryType: row.memoryType,
    sourceRef: asJsonObject(row.sourceRef),
    sourceProposalId: row.sourceProposalId,
    payload: asJsonObject(row.payload),
    confidence: row.confidence,
    salience: row.salience,
    status: row.status as MemoryItem['status'],
    decayPolicy: asJsonObjectOrNull(row.decayPolicy ?? null),
    expiresAt: row.expiresAt ?? null,
    acceptedAt: row.acceptedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function selfSpineProposalFromRow(row: {
  id: string
  agentId: string
  sourceRef: Prisma.JsonValue
  patch: Prisma.JsonValue
  rationale: string
  status: string
  idempotencyKey: string
  reviewedBy: string | null
  reviewedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): SelfSpineUpdateProposal {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    sourceRef: asJsonObject(row.sourceRef),
    patch: asJsonObject(row.patch),
    rationale: row.rationale,
    status: row.status as SelfSpineUpdateProposal['status'],
    idempotencyKey: row.idempotencyKey,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function selfSpineVersionFromRow(row: {
  id: string
  agentId: string
  version: number
  snapshot: Prisma.JsonValue
  diff: Prisma.JsonValue
  sourceProposalId: string | null
  rollbackOfVersion: number | null
  status: string
  createdAt: Date
}): SelfSpineVersion {
  return {
    id: row.id,
    agentId: row.agentId as AgentId,
    version: row.version,
    snapshot: asJsonObject(row.snapshot),
    diff: asJsonObject(row.diff),
    sourceProposalId: row.sourceProposalId,
    rollbackOfVersion: row.rollbackOfVersion,
    status: row.status as SelfSpineVersion['status'],
    createdAt: row.createdAt,
  }
}

export async function getOrCreateMainAgentRuntime() {
  return prisma.agentRuntimeSnapshot.upsert({
    where: { agentId: MAIN_AGENT_ID },
    update: {},
    create: {
      agentId: MAIN_AGENT_ID,
      schemaVersion: AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: { messages: [] },
      sessionSnapshot: { scenes: [] },
    },
  })
}

export async function getAgentRuntimeSnapshot(agentId: AgentId = MAIN_AGENT_ID) {
  return prisma.agentRuntimeSnapshot.findUnique({ where: { agentId } })
}

export async function upsertAgentRuntimeSnapshot(input: {
  agentId?: AgentId
  schemaVersion?: number
  contextSnapshot: Prisma.JsonObject
  sessionSnapshot: Prisma.JsonObject
}) {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  assertRuntimeSnapshotReferenceOnly(input.contextSnapshot)
  const existing = await prisma.agentRuntimeSnapshot.findUnique({ where: { agentId } })
  const sessionSnapshot = mergeRuntimeSessionSnapshot(
    existing ? asJsonObject(existing.sessionSnapshot) : null,
    input.sessionSnapshot,
  )
  return prisma.agentRuntimeSnapshot.upsert({
    where: { agentId },
    update: {
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot,
    },
    create: {
      agentId,
      schemaVersion: input.schemaVersion ?? AGENT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: input.contextSnapshot,
      sessionSnapshot,
    },
  })
}

export async function getOrCreateScene(input: {
  agentId?: AgentId
  kind: SceneKind
  externalId: string | number
  displayName?: string | null
  policy?: Prisma.JsonObject
}) {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const externalId = String(input.externalId)
  return prisma.scene.upsert({
    where: { agentId_kind_externalId: { agentId, kind: input.kind, externalId } },
    update: {
      displayName: input.displayName ?? undefined,
      policy: input.policy ?? undefined,
    },
    create: {
      id: makeSceneId(input.kind, externalId),
      agentId,
      kind: input.kind,
      externalId,
      displayName: input.displayName ?? null,
      policy: input.policy ?? {},
    },
  })
}

export async function createOrReuseRuntimeEvent(input: {
  sceneId: SceneId
  eventType: RuntimeEventType
  payload: ReferencePayload
  occurredAt: Date
  idempotencyKey: string
}): Promise<RuntimeEventRecord> {
  const row = await prisma.runtimeEvent.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('event', `${input.sceneId}:${input.idempotencyKey}`),
      sceneId: input.sceneId,
      eventType: input.eventType,
      payload: toReferencePayload(input.payload),
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    },
  })
  return {
    id: row.id,
    sceneId: row.sceneId as SceneId,
    eventType: row.eventType as RuntimeEventType,
    payload: asJsonObject(row.payload) as ReferencePayload,
    occurredAt: row.occurredAt,
    idempotencyKey: row.idempotencyKey,
    consumedAt: row.consumedAt,
  }
}

export async function createOrReuseDecision(input: {
  opportunityId: string
  idempotencyKey: string
  policyVersion: string
  verdict: DecisionVerdict
  actionType: ActionType
  riskLevel: RiskLevel
  reason: string
  barrierInput: Prisma.JsonObject
  barrierOutput: Prisma.JsonObject
}): Promise<Decision> {
  assertActionIntentPayloadSafe(input.barrierInput)
  assertActionIntentPayloadSafe(input.barrierOutput)
  const row = await prisma.decision.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('decision', `${input.opportunityId}:${input.idempotencyKey}`),
      opportunityId: input.opportunityId,
      idempotencyKey: input.idempotencyKey,
      policyVersion: input.policyVersion,
      verdict: input.verdict,
      riskLevel: input.riskLevel,
      reason: input.reason,
      barrierInput: input.barrierInput,
      barrierOutput: input.barrierOutput,
    },
  })
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    idempotencyKey: row.idempotencyKey,
    policyVersion: row.policyVersion,
    verdict: row.verdict as DecisionVerdict,
    actionType: input.actionType,
    riskLevel: row.riskLevel as RiskLevel,
    reason: row.reason,
    barrierInput: asJsonObject(row.barrierInput),
    barrierOutput: asJsonObject(row.barrierOutput),
    createdAt: row.createdAt,
  }
}

export async function createOrReuseOpportunity(input: {
  sceneId: SceneId
  runtimeEventId?: string | null
  queueKind: QueueKind
  opportunityType: OpportunityType
  priority?: number
  deadlineAt?: Date | null
  payload: ReferencePayload
  status?: string
  idempotencyKey: string
}) {
  return prisma.opportunity.upsert({
    where: { sceneId_idempotencyKey: { sceneId: input.sceneId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('opportunity', `${input.sceneId}:${input.idempotencyKey}`),
      sceneId: input.sceneId,
      runtimeEventId: input.runtimeEventId ?? null,
      queueKind: input.queueKind,
      opportunityType: input.opportunityType,
      priority: input.priority ?? 0,
      deadlineAt: input.deadlineAt ?? null,
      payload: toReferencePayload(input.payload),
      status: input.status ?? 'pending',
      idempotencyKey: input.idempotencyKey,
    },
  })
}

export async function createOrReuseActionIntent(input: {
  opportunityId: string
  decisionId?: string | null
  actionType: ActionType
  targetSceneId: SceneId
  payload: Prisma.JsonObject
  dryRun?: boolean
  riskLevel?: RiskLevel
  status?: ActionIntentStatus
  idempotencyKey: string
}) {
  assertActionIntentPayloadSafe(input.payload)
  return prisma.actionIntent.upsert({
    where: { opportunityId_idempotencyKey: { opportunityId: input.opportunityId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('intent', `${input.opportunityId}:${input.idempotencyKey}`),
      opportunityId: input.opportunityId,
      decisionId: input.decisionId ?? null,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      payload: input.payload,
      dryRun: input.dryRun ?? false,
      riskLevel: input.riskLevel ?? 'L1',
      status: input.status ?? 'proposed',
      idempotencyKey: input.idempotencyKey,
    },
  })
}

export async function createOrReuseActionRecord(input: {
  actionIntentId: string
  actionType: ActionType
  targetSceneId: SceneId
  deliveryState?: ActionDeliveryState
  idempotencyKey: string
  resultPayload?: Prisma.JsonObject | null
}): Promise<ActionRecord> {
  const row = await prisma.actionRecord.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      id: makeId('action', input.idempotencyKey),
      actionIntentId: input.actionIntentId,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      deliveryState: input.deliveryState ?? 'pending',
      idempotencyKey: input.idempotencyKey,
      resultPayload: input.resultPayload ?? Prisma.JsonNull,
    },
  })
  return {
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function markActionRecordDeliveryState(
  id: string,
  deliveryState: ActionDeliveryState,
  resultPayload?: Prisma.JsonObject | null,
): Promise<void> {
  await prisma.actionRecord.update({
    where: { id },
    data: {
      deliveryState,
      resultPayload: resultPayload === undefined ? undefined : resultPayload ?? Prisma.JsonNull,
    },
  })
}

export async function listSentActionRecordsForScene(sceneId: SceneId): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      targetSceneId: sceneId,
      deliveryState: { in: ['sent', 'acked'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function listRecoverableActionRecords(sceneIds?: SceneId[]): Promise<ActionRecord[]> {
  const rows = await prisma.actionRecord.findMany({
    where: {
      ...(sceneIds?.length ? { targetSceneId: { in: sceneIds } } : {}),
      deliveryState: { in: ['pending', 'sending', 'failed', 'acked'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    id: row.id,
    actionIntentId: row.actionIntentId,
    actionType: row.actionType as ActionType,
    targetSceneId: row.targetSceneId as SceneId,
    deliveryState: row.deliveryState as ActionDeliveryState,
    idempotencyKey: row.idempotencyKey,
    resultPayload: row.resultPayload ? asJsonObject(row.resultPayload) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function createOrReuseMemoryProposal(input: {
  agentId?: AgentId
  sourceRef: Prisma.JsonObject
  proposalType: MemoryType
  payload: Prisma.JsonObject
  confidence?: number | null
  salience?: number | null
  status?: MemoryProposal['status']
  decayPolicy?: Prisma.JsonObject | null
  expiresAt?: Date | null
  idempotencyKey: string
}): Promise<MemoryProposal> {
  assertMemoryType(input.proposalType)
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const row = await prisma.memoryProposal.upsert({
    where: { agentId_idempotencyKey: { agentId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('memory-proposal', `${agentId}:${input.idempotencyKey}`),
      agentId,
      sourceRef: input.sourceRef,
      proposalType: input.proposalType,
      payload: input.payload,
      confidence: input.confidence ?? null,
      salience: input.salience ?? null,
      status: input.status ?? 'proposed',
      decayPolicy: input.decayPolicy ?? Prisma.JsonNull,
      expiresAt: input.expiresAt ?? null,
      idempotencyKey: input.idempotencyKey,
    },
  })
  return memoryProposalFromRow(row)
}

export async function reviewMemoryProposal(input: {
  proposalId: string
  verdict: 'accept' | 'reject' | 'edit'
  scope?: string
  editedPayload?: Prisma.JsonObject
}): Promise<{ proposal: MemoryProposal; item: MemoryItem | null }> {
  const now = new Date()
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.memoryProposal.findUnique({ where: { id: input.proposalId } })
    if (!proposal) throw new Error(`memory proposal not found: ${input.proposalId}`)
    assertMemoryType(proposal.proposalType)

    if (input.verdict === 'reject') {
      const updated = await tx.memoryProposal.update({
        where: { id: proposal.id },
        data: { status: 'rejected' },
      })
      return { proposal: memoryProposalFromRow(updated), item: null }
    }

    if (input.verdict === 'edit') {
      if (!input.editedPayload) throw new Error('edited memory proposal requires editedPayload')
      const updated = await tx.memoryProposal.update({
        where: { id: proposal.id },
        data: { status: 'edited', payload: input.editedPayload },
      })
      return { proposal: memoryProposalFromRow(updated), item: null }
    }

    const item = await tx.memoryItem.upsert({
      where: { sourceProposalId: proposal.id },
      update: {},
      create: {
        id: makeId('memory-item', `${proposal.agentId}:${proposal.id}`),
        agentId: proposal.agentId,
        scope: input.scope ?? 'global',
        memoryType: proposal.proposalType,
        sourceRef: asJsonObject(proposal.sourceRef),
        sourceProposalId: proposal.id,
        payload: input.editedPayload ?? asJsonObject(proposal.payload),
        confidence: proposal.confidence,
        salience: proposal.salience,
        status: 'active',
        decayPolicy: proposal.decayPolicy ?? Prisma.JsonNull,
        expiresAt: proposal.expiresAt,
        acceptedAt: now,
      },
    })
    const updated = await tx.memoryProposal.update({
      where: { id: proposal.id },
      data: { status: 'accepted' },
    })
    return { proposal: memoryProposalFromRow(updated), item: memoryItemFromRow(item) }
  })
}

export async function autoAcceptMemoryProposalIfAllowed(input: {
  proposalId: string
  policy: MemoryAutoAcceptPolicy
  scope?: string
}): Promise<{ accepted: boolean; reason: string; proposal: MemoryProposal; item: MemoryItem | null }> {
  const proposal = await prisma.memoryProposal.findUnique({ where: { id: input.proposalId } })
  if (!proposal) throw new Error(`memory proposal not found: ${input.proposalId}`)
  const mapped = memoryProposalFromRow(proposal)
  if (!canAutoAcceptMemoryProposal(mapped, input.policy)) {
    return { accepted: false, reason: 'memory auto-accept policy rejected proposal', proposal: mapped, item: null }
  }
  const result = await reviewMemoryProposal({
    proposalId: input.proposalId,
    verdict: 'accept',
    scope: input.scope,
  })
  return { accepted: true, reason: 'memory auto-accept policy accepted low-risk proposal', ...result }
}

export async function createOrReuseSelfSpineUpdateProposal(input: {
  agentId?: AgentId
  sourceRef: Prisma.JsonObject
  patch: Prisma.JsonObject
  rationale: string
  status?: SelfSpineUpdateProposal['status']
  idempotencyKey: string
}): Promise<SelfSpineUpdateProposal> {
  assertSelfSpinePatch(input.patch)
  const agentId = input.agentId ?? MAIN_AGENT_ID
  const row = await prisma.selfSpineUpdateProposal.upsert({
    where: { agentId_idempotencyKey: { agentId, idempotencyKey: input.idempotencyKey } },
    update: {},
    create: {
      id: makeId('self-spine-proposal', `${agentId}:${input.idempotencyKey}`),
      agentId,
      sourceRef: input.sourceRef,
      patch: input.patch,
      rationale: input.rationale,
      status: input.status ?? 'proposed',
      idempotencyKey: input.idempotencyKey,
    },
  })
  return selfSpineProposalFromRow(row)
}

export async function getLatestSelfSpineVersion(agentId: AgentId = MAIN_AGENT_ID): Promise<SelfSpineVersion | null> {
  const row = await prisma.selfSpineVersion.findFirst({
    where: { agentId, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (!row) return null
  return selfSpineVersionFromRow(row)
}

export async function reviewSelfSpineUpdateProposal(input: {
  proposalId: string
  verdict: 'accept' | 'reject'
  reviewedBy: string
}): Promise<{ proposal: SelfSpineUpdateProposal; version: SelfSpineVersion | null }> {
  const reviewedAt = new Date()
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.selfSpineUpdateProposal.findUnique({ where: { id: input.proposalId } })
    if (!proposal) throw new Error(`self spine update proposal not found: ${input.proposalId}`)

    const existingVersion = await tx.selfSpineVersion.findFirst({ where: { sourceProposalId: proposal.id } })
    if (existingVersion) {
      return {
        proposal: selfSpineProposalFromRow(proposal),
        version: selfSpineVersionFromRow(existingVersion),
      }
    }

    if (input.verdict === 'reject') {
      if (proposal.status === 'accepted') {
        throw new Error(`accepted self spine proposal cannot be rejected: ${proposal.id}`)
      }
      const rejected = await tx.selfSpineUpdateProposal.update({
        where: { id: proposal.id },
        data: { status: 'rejected', reviewedBy: input.reviewedBy, reviewedAt },
      })
      return {
        proposal: selfSpineProposalFromRow(rejected),
        version: null,
      }
    }

    if (proposal.status !== 'proposed') {
      throw new Error(`self spine proposal is not reviewable: ${proposal.id}:${proposal.status}`)
    }

    const sourceRef = asJsonObject(proposal.sourceRef)
    const patch = asJsonObject(proposal.patch)
    assertSelfSpineSourceCanMutate(sourceRef)
    assertSelfSpinePatch(patch)

    const latest = await tx.selfSpineVersion.findFirst({
      where: { agentId: proposal.agentId, status: 'active' },
      orderBy: { version: 'desc' },
    })
    const previousSnapshot = latest ? asJsonObject(latest.snapshot) : {}
    const nextVersion = (latest?.version ?? 0) + 1
    const snapshot = mergeJsonPatch(previousSnapshot, patch)

    await tx.selfSpineVersion.updateMany({
      where: { agentId: proposal.agentId, status: 'active' },
      data: { status: 'superseded' },
    })
    const version = await tx.selfSpineVersion.create({
      data: {
        id: makeId('self-spine-version', `${proposal.agentId}:${nextVersion}`),
        agentId: proposal.agentId,
        version: nextVersion,
        snapshot,
        diff: {
          previousVersion: latest?.version ?? null,
          changedSections: Object.keys(patch),
          patch,
          rationale: proposal.rationale,
          reviewedBy: input.reviewedBy,
        },
        sourceProposalId: proposal.id,
        status: 'active',
      },
    })
    const accepted = await tx.selfSpineUpdateProposal.update({
      where: { id: proposal.id },
      data: { status: 'accepted', reviewedBy: input.reviewedBy, reviewedAt },
    })
    return {
      proposal: selfSpineProposalFromRow(accepted),
      version: selfSpineVersionFromRow(version),
    }
  })
}

export async function rollbackSelfSpineVersion(input: {
  agentId?: AgentId
  targetVersion: number
  reviewedBy: string
}): Promise<SelfSpineVersion> {
  const agentId = input.agentId ?? MAIN_AGENT_ID
  return prisma.$transaction(async (tx) => {
    const target = await tx.selfSpineVersion.findUnique({
      where: { agentId_version: { agentId, version: input.targetVersion } },
    })
    if (!target) throw new Error(`self spine version not found: ${agentId}:${input.targetVersion}`)

    const latest = await tx.selfSpineVersion.findFirst({
      where: { agentId, status: 'active' },
      orderBy: { version: 'desc' },
    })
    const nextVersion = (latest?.version ?? 0) + 1

    await tx.selfSpineVersion.updateMany({
      where: { agentId, status: 'active' },
      data: { status: 'rolled_back' },
    })
    const row = await tx.selfSpineVersion.create({
      data: {
        id: makeId('self-spine-version', `${agentId}:${nextVersion}`),
        agentId,
        version: nextVersion,
        snapshot: asJsonObject(target.snapshot),
        diff: {
          previousVersion: latest?.version ?? null,
          rollbackOfVersion: target.version,
          reviewedBy: input.reviewedBy,
        },
        rollbackOfVersion: target.version,
        status: 'active',
      },
    })
    return selfSpineVersionFromRow(row)
  })
}
