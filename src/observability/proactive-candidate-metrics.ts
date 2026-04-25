import type { TokenUsageSummary } from '../llm/token-usage.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'

export type ProactiveCandidateArtifactStatus = 'suppressed' | 'no_candidate' | 'candidate_generated' | 'unknown'
export type ProactiveCandidateNormalizedStatus =
  | 'candidate_generated'
  | 'no_candidate'
  | 'gate_suppressed'
  | 'policy_suppressed'
  | 'unknown'
export type TokenUsageState = 'captured' | 'not_applicable' | 'unknown'
export type MessageTypeCompleteness = 'captured' | 'inferred_from_opportunity_id' | 'unknown'
export type CandidateTextQualityBucket = 'empty' | 'too_short' | 'normal' | 'too_long'
export type CandidateMessageSegmentType =
  | 'text'
  | 'image'
  | 'video'
  | 'record'
  | 'file'
  | 'face'
  | 'at'
  | 'reply'
  | 'json_card'
  | 'raw'
  | 'unknown'

const KNOWN_SEGMENT_TYPES = new Set<CandidateMessageSegmentType>([
  'text',
  'image',
  'video',
  'record',
  'file',
  'face',
  'at',
  'reply',
  'json_card',
  'raw',
])

const PRIMARY_TYPE_PRIORITY: CandidateMessageSegmentType[] = [
  'video',
  'image',
  'record',
  'file',
  'json_card',
  'face',
  'at',
  'reply',
  'text',
  'raw',
]

export interface ProactiveCandidateReportOptions {
  from: Date
  to: Date
  groupId?: number
  reviewLimit?: number
  maxAudits?: number
}

export interface ReplyAuditMetricRow {
  id: number
  groupId: bigint | number | string
  opportunityId: string
  runtimeKey: string
  scopeKey: string
  replyIntentId: string
  auditKind: string
  payload: unknown
  createdAt: Date
}

export interface MessageMetricRow {
  id: number
  groupId: bigint | number | string
  messageId: bigint | number | string
  senderId: bigint | number | string
  senderNickname: string | null
  senderGroupNickname: string | null
  content: unknown
  searchText?: string | null
  resolvedText?: string | null
  createdAt?: Date
}

export interface ProactiveCandidateMetricsDb {
  replyAudit: {
    findMany(args: any): Promise<ReplyAuditMetricRow[]>
  }
  message: {
    findMany(args: any): Promise<MessageMetricRow[]>
  }
}

export interface ProactiveCandidateObservation {
  auditId: number
  createdAt: Date
  date: string
  groupId: number
  runtimeKey: string
  opportunityId: string
  artifactStatus: ProactiveCandidateArtifactStatus
  normalizedStatus: ProactiveCandidateNormalizedStatus
  gateReasons: string[]
  policyReasons: string[]
  score: number | null
  judgeAdvice?: unknown
  candidateText?: string
  termination?: string
  model?: string
  sourceKind?: string
  triggerMessageRowId?: number
  incorporatedMessageRowId?: number
  tokenUsage?: TokenUsageSummary
  tokenUsageState: TokenUsageState
  messageTypeCompleteness: MessageTypeCompleteness
  primaryMessageType: CandidateMessageSegmentType
  segmentTypes: CandidateMessageSegmentType[]
  triggerTextPreview?: string
  senderId?: number
  senderName?: string
  qualityBucket: CandidateTextQualityBucket
  qualitySignals: string[]
  qualityWarnings: string[]
}

export interface DailyGroupMetric {
  date: string
  groupId: number
  totalAudits: number
  candidateGenerated: number
  gateSuppressed: number
  policySuppressed: number
  noCandidate: number
  unknown: number
  tokenUsageCaptured: number
  tokenUsageUnknown: number
  totalTokens: number
}

export interface ReasonBreakdownMetric {
  kind: 'gate' | 'policy'
  reason: string
  count: number
}

export interface MessageTypeBreakdownMetric {
  primaryMessageType: CandidateMessageSegmentType
  segmentTypeSet: string
  total: number
  candidateGenerated: number
  suppressed: number
  noCandidate: number
  capturedCount: number
  inferredCount: number
  unknownCount: number
  capturedCandidateRate: number | null
  capturedSuppressionRate: number | null
}

export interface TokenUsageSummaryMetric {
  captured: number
  unknown: number
  notApplicable: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  calls: number
}

export interface ReviewQueueItem {
  auditId: number
  createdAt: string
  groupId: number
  opportunityId: string
  score: number | null
  candidateText: string
  triggerTextPreview?: string
  gateReasons: string[]
  policyReasons: string[]
  primaryMessageType: CandidateMessageSegmentType
  segmentTypes: CandidateMessageSegmentType[]
  messageTypeCompleteness: MessageTypeCompleteness
  tokenUsageState: TokenUsageState
  tokenUsage?: TokenUsageSummary
  qualityBucket: CandidateTextQualityBucket
  qualitySignals: string[]
  qualityWarnings: string[]
}

export interface ProactiveCandidateMetrics {
  from: string
  to: string
  observations: ProactiveCandidateObservation[]
  dailyByGroup: DailyGroupMetric[]
  gateBreakdown: ReasonBreakdownMetric[]
  messageTypeBreakdown: MessageTypeBreakdownMetric[]
  qualityBuckets: Record<CandidateTextQualityBucket, number>
  tokenUsage: TokenUsageSummaryMetric
  reviewQueue: ReviewQueueItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function normalizeArtifactStatus(value: unknown, payload: Record<string, unknown>): ProactiveCandidateArtifactStatus {
  if (value === 'suppressed' || value === 'no_candidate' || value === 'candidate_generated') return value
  if (typeof payload.candidateText === 'string' && payload.candidateText.trim()) return 'candidate_generated'
  if (stringArray(payload.gateReasons).length > 0 || stringArray(payload.policyReasons).length > 0) return 'suppressed'
  return 'unknown'
}

function normalizeStatus(
  artifactStatus: ProactiveCandidateArtifactStatus,
  gateReasons: string[],
  policyReasons: string[],
): ProactiveCandidateNormalizedStatus {
  if (artifactStatus === 'candidate_generated') return 'candidate_generated'
  if (artifactStatus === 'no_candidate') return 'no_candidate'
  if (artifactStatus === 'suppressed') {
    return policyReasons.length > 0 && gateReasons.length === 0 ? 'policy_suppressed' : 'gate_suppressed'
  }
  if (policyReasons.length > 0) return 'policy_suppressed'
  if (gateReasons.length > 0) return 'gate_suppressed'
  return 'unknown'
}

function parseTokenUsage(value: unknown): TokenUsageSummary | undefined {
  if (!isRecord(value) || !isRecord(value.total)) return undefined
  const promptTokens = asNumber(value.total.promptTokens)
  const completionTokens = asNumber(value.total.completionTokens)
  const totalTokens = asNumber(value.total.totalTokens)
  const calls = asNumber(value.total.calls)
  if (
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    calls === undefined
  ) {
    return undefined
  }

  const byOperation: TokenUsageSummary['byOperation'] = {}
  if (isRecord(value.byOperation)) {
    for (const [operation, bucket] of Object.entries(value.byOperation)) {
      if (!isRecord(bucket)) continue
      const operationPrompt = asNumber(bucket.promptTokens)
      const operationCompletion = asNumber(bucket.completionTokens)
      const operationTotal = asNumber(bucket.totalTokens)
      const operationCalls = asNumber(bucket.calls)
      if (
        operationPrompt === undefined ||
        operationCompletion === undefined ||
        operationTotal === undefined ||
        operationCalls === undefined
      ) {
        continue
      }
      byOperation[operation] = {
        promptTokens: operationPrompt,
        completionTokens: operationCompletion,
        totalTokens: operationTotal,
        calls: operationCalls,
      }
    }
  }

  return {
    total: { promptTokens, completionTokens, totalTokens, calls },
    byOperation,
  }
}

function parseTokenUsageState(value: unknown): TokenUsageState | undefined {
  return value === 'captured' || value === 'not_applicable' || value === 'unknown' ? value : undefined
}

function resolveTokenUsageState(
  tokenUsage: TokenUsageSummary | undefined,
  normalizedStatus: ProactiveCandidateNormalizedStatus,
  payloadState: TokenUsageState | undefined,
): TokenUsageState {
  if (payloadState === 'captured' && tokenUsage) return 'captured'
  if (payloadState === 'not_applicable' || payloadState === 'unknown') return payloadState
  if (tokenUsage) return 'captured'
  if (normalizedStatus === 'gate_suppressed' || normalizedStatus === 'policy_suppressed') return 'not_applicable'
  return 'unknown'
}

function inferMessageRowIdFromOpportunityId(opportunityId: string): number | undefined {
  const match = opportunityId.match(/(?:^|:)message:(\d+)(?::|$)/)
  if (!match) return undefined
  return asNumber(match[1])
}

function extractSegments(content: unknown): ParsedSegment[] {
  const candidate = Array.isArray(content)
    ? content
    : isRecord(content) && Array.isArray(content.segments)
      ? content.segments
      : isRecord(content) && Array.isArray(content.content)
        ? content.content
        : []

  return candidate.filter((item): item is ParsedSegment => isRecord(item) && typeof item.type === 'string')
}

function normalizeSegmentType(type: string): CandidateMessageSegmentType {
  return KNOWN_SEGMENT_TYPES.has(type as CandidateMessageSegmentType)
    ? (type as CandidateMessageSegmentType)
    : 'raw'
}

function messageTypeDetails(message: MessageMetricRow | undefined): {
  primaryMessageType: CandidateMessageSegmentType
  segmentTypes: CandidateMessageSegmentType[]
  triggerTextPreview?: string
} {
  if (!message) {
    return { primaryMessageType: 'unknown', segmentTypes: ['unknown'] }
  }

  const segments = extractSegments(message.content)
  const segmentTypes = [...new Set(segments.map((segment) => normalizeSegmentType(segment.type)))].sort()
  const primaryMessageType =
    PRIMARY_TYPE_PRIORITY.find((type) => segmentTypes.includes(type)) ?? segmentTypes[0] ?? 'unknown'
  const plainText = segments.length > 0 ? segmentsToPlainText(segments) : ''
  const previewSource = plainText || message.resolvedText || message.searchText || ''
  return {
    primaryMessageType,
    segmentTypes: segmentTypes.length > 0 ? segmentTypes : ['unknown'],
    triggerTextPreview: preview(previewSource, 120),
  }
}

function preview(text: string | undefined, maxChars: number): string | undefined {
  const trimmed = text?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed
}

function qualityBucket(candidateText: string | undefined): CandidateTextQualityBucket {
  const text = candidateText?.trim() ?? ''
  if (!text) return 'empty'
  if ([...text].length < 4) return 'too_short'
  if ([...text].length > 120) return 'too_long'
  return 'normal'
}

function qualitySignals(input: {
  candidateText?: string
  score: number | null
  segmentTypes: CandidateMessageSegmentType[]
}): { signals: string[]; warnings: string[] } {
  const text = input.candidateText?.trim() ?? ''
  const bucket = qualityBucket(text)
  const signals: string[] = []
  const warnings: string[] = []
  if (bucket !== 'normal') warnings.push(bucket)
  if (/[?？]/.test(text)) signals.push('has_question')
  if (input.segmentTypes.some((type) => ['image', 'video', 'record', 'file', 'json_card'].includes(type))) {
    signals.push('has_media_reference')
  }
  if ((input.score ?? 0) >= 0.7 && [...text].length > 0 && [...text].length < 8) {
    signals.push('high_score_low_text')
  }
  return { signals, warnings }
}

function textSignature(candidateText: string | undefined): string | undefined {
  const normalized = candidateText?.replace(/\s+/g, '').toLowerCase()
  return normalized && normalized.length > 0 ? normalized : undefined
}

export function normalizeProactiveCandidateAudit(
  row: ReplyAuditMetricRow,
  messageById: Map<number, MessageMetricRow> = new Map(),
): ProactiveCandidateObservation {
  const payload = isRecord(row.payload) ? row.payload : {}
  const gateReasons = stringArray(payload.gateReasons)
  const policyReasons = stringArray(payload.policyReasons)
  const artifactStatus = normalizeArtifactStatus(payload.status, payload)
  const normalizedStatus = normalizeStatus(artifactStatus, gateReasons, policyReasons)
  const tokenUsage = parseTokenUsage(payload.tokenUsage)
  const triggerMessageRowId = asNumber(payload.triggerMessageRowId)
  const incorporatedMessageRowId = asNumber(payload.incorporatedMessageRowId)
  const inferredMessageRowId = triggerMessageRowId === undefined
    ? inferMessageRowIdFromOpportunityId(row.opportunityId)
    : undefined
  const messageRowId = triggerMessageRowId ?? inferredMessageRowId
  const message = messageRowId === undefined ? undefined : messageById.get(messageRowId)
  const messageTypeCompleteness: MessageTypeCompleteness =
    triggerMessageRowId !== undefined && message ? 'captured' : inferredMessageRowId !== undefined && message ? 'inferred_from_opportunity_id' : 'unknown'
  const messageTypes = messageTypeDetails(message)
  const score = asNumber(payload.score) ?? asNumber(payload.replyProbability) ?? null
  const candidateText = asString(payload.candidateText)
  const quality = qualitySignals({
    candidateText,
    score,
    segmentTypes: messageTypes.segmentTypes,
  })

  return {
    auditId: row.id,
    createdAt: row.createdAt,
    date: normalizeDateKey(row.createdAt),
    groupId: asNumber(row.groupId) ?? 0,
    runtimeKey: row.runtimeKey,
    opportunityId: row.opportunityId,
    artifactStatus,
    normalizedStatus,
    gateReasons,
    policyReasons,
    score,
    judgeAdvice: payload.judgeAdvice,
    candidateText,
    termination: asString(payload.termination),
    model: asString(payload.model),
    sourceKind: asString(payload.sourceKind),
    triggerMessageRowId,
    incorporatedMessageRowId,
    tokenUsage,
    tokenUsageState: resolveTokenUsageState(tokenUsage, normalizedStatus, parseTokenUsageState(payload.tokenUsageState)),
    messageTypeCompleteness,
    primaryMessageType: messageTypes.primaryMessageType,
    segmentTypes: messageTypes.segmentTypes,
    triggerTextPreview: messageTypes.triggerTextPreview,
    senderId: message ? asNumber(message.senderId) : undefined,
    senderName: message ? (message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId)) : undefined,
    qualityBucket: qualityBucket(candidateText),
    qualitySignals: quality.signals,
    qualityWarnings: quality.warnings,
  }
}

function addDuplicateWarnings(observations: ProactiveCandidateObservation[]): ProactiveCandidateObservation[] {
  const counts = new Map<string, number>()
  for (const observation of observations) {
    if (observation.normalizedStatus !== 'candidate_generated') continue
    const signature = textSignature(observation.candidateText)
    if (!signature) continue
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }

  return observations.map((observation) => {
    const signature = textSignature(observation.candidateText)
    if (!signature || (counts.get(signature) ?? 0) <= 1) return observation
    return {
      ...observation,
      qualityWarnings: [...new Set([...observation.qualityWarnings, 'duplicate_text_signature'])],
    }
  })
}

function sortReasonBreakdown(items: ReasonBreakdownMetric[]): ReasonBreakdownMetric[] {
  return items.sort(
    (left, right) =>
      right.count - left.count ||
      left.kind.localeCompare(right.kind) ||
      left.reason.localeCompare(right.reason),
  )
}

export function buildProactiveCandidateMetrics(
  observationsInput: ProactiveCandidateObservation[],
  options: Pick<ProactiveCandidateReportOptions, 'from' | 'to' | 'reviewLimit'>,
): ProactiveCandidateMetrics {
  const observations = addDuplicateWarnings(observationsInput)
  const daily = new Map<string, DailyGroupMetric>()
  const reasons = new Map<string, ReasonBreakdownMetric>()
  const messageTypes = new Map<string, MessageTypeBreakdownMetric>()
  const qualityBuckets: Record<CandidateTextQualityBucket, number> = {
    empty: 0,
    too_short: 0,
    normal: 0,
    too_long: 0,
  }
  const tokenUsage: TokenUsageSummaryMetric = {
    captured: 0,
    unknown: 0,
    notApplicable: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    calls: 0,
  }

  for (const observation of observations) {
    const dailyKey = `${observation.date}:${observation.groupId}`
    const dailyMetric = daily.get(dailyKey) ?? {
      date: observation.date,
      groupId: observation.groupId,
      totalAudits: 0,
      candidateGenerated: 0,
      gateSuppressed: 0,
      policySuppressed: 0,
      noCandidate: 0,
      unknown: 0,
      tokenUsageCaptured: 0,
      tokenUsageUnknown: 0,
      totalTokens: 0,
    }
    dailyMetric.totalAudits += 1
    if (observation.normalizedStatus === 'candidate_generated') dailyMetric.candidateGenerated += 1
    else if (observation.normalizedStatus === 'gate_suppressed') dailyMetric.gateSuppressed += 1
    else if (observation.normalizedStatus === 'policy_suppressed') dailyMetric.policySuppressed += 1
    else if (observation.normalizedStatus === 'no_candidate') dailyMetric.noCandidate += 1
    else dailyMetric.unknown += 1
    if (observation.tokenUsageState === 'captured' && observation.tokenUsage) {
      dailyMetric.tokenUsageCaptured += 1
      dailyMetric.totalTokens += observation.tokenUsage.total.totalTokens
    } else if (observation.tokenUsageState === 'unknown') {
      dailyMetric.tokenUsageUnknown += 1
    }
    daily.set(dailyKey, dailyMetric)

    for (const reason of observation.gateReasons) {
      const key = `gate:${reason}`
      reasons.set(key, { kind: 'gate', reason, count: (reasons.get(key)?.count ?? 0) + 1 })
    }
    for (const reason of observation.policyReasons) {
      const key = `policy:${reason}`
      reasons.set(key, { kind: 'policy', reason, count: (reasons.get(key)?.count ?? 0) + 1 })
    }

    const segmentTypeSet = observation.segmentTypes.join('+')
    const messageKey = `${observation.primaryMessageType}:${segmentTypeSet}`
    const messageMetric = messageTypes.get(messageKey) ?? {
      primaryMessageType: observation.primaryMessageType,
      segmentTypeSet,
      total: 0,
      candidateGenerated: 0,
      suppressed: 0,
      noCandidate: 0,
      capturedCount: 0,
      inferredCount: 0,
      unknownCount: 0,
      capturedCandidateRate: null,
      capturedSuppressionRate: null,
    }
    messageMetric.total += 1
    if (observation.normalizedStatus === 'candidate_generated') messageMetric.candidateGenerated += 1
    if (observation.normalizedStatus === 'gate_suppressed' || observation.normalizedStatus === 'policy_suppressed') {
      messageMetric.suppressed += 1
    }
    if (observation.normalizedStatus === 'no_candidate') messageMetric.noCandidate += 1
    if (observation.messageTypeCompleteness === 'captured') messageMetric.capturedCount += 1
    else if (observation.messageTypeCompleteness === 'inferred_from_opportunity_id') messageMetric.inferredCount += 1
    else messageMetric.unknownCount += 1
    messageTypes.set(messageKey, messageMetric)

    qualityBuckets[observation.qualityBucket] += 1
    if (observation.tokenUsageState === 'captured' && observation.tokenUsage) {
      tokenUsage.captured += 1
      tokenUsage.promptTokens += observation.tokenUsage.total.promptTokens
      tokenUsage.completionTokens += observation.tokenUsage.total.completionTokens
      tokenUsage.totalTokens += observation.tokenUsage.total.totalTokens
      tokenUsage.calls += observation.tokenUsage.total.calls
    } else if (observation.tokenUsageState === 'not_applicable') {
      tokenUsage.notApplicable += 1
    } else {
      tokenUsage.unknown += 1
    }
  }

  const messageTypeBreakdown = [...messageTypes.values()]
    .map((metric) => {
      if (metric.capturedCount === 0) return metric
      const capturedObservations = observations.filter(
        (observation) =>
          observation.messageTypeCompleteness === 'captured' &&
          observation.primaryMessageType === metric.primaryMessageType &&
          observation.segmentTypes.join('+') === metric.segmentTypeSet,
      )
      const capturedGenerated = capturedObservations.filter(
        (observation) => observation.normalizedStatus === 'candidate_generated',
      ).length
      const capturedSuppressed = capturedObservations.filter(
        (observation) =>
          observation.normalizedStatus === 'gate_suppressed' ||
          observation.normalizedStatus === 'policy_suppressed',
      ).length
      return {
        ...metric,
        capturedCandidateRate: capturedGenerated / metric.capturedCount,
        capturedSuppressionRate: capturedSuppressed / metric.capturedCount,
      }
    })
    .sort((left, right) => right.total - left.total || left.primaryMessageType.localeCompare(right.primaryMessageType))

  const reviewQueue = observations
    .filter((observation) => observation.normalizedStatus === 'candidate_generated' && observation.candidateText?.trim())
    .sort((left, right) => {
      const scoreDiff = (right.score ?? -1) - (left.score ?? -1)
      if (scoreDiff !== 0) return scoreDiff
      const createdDiff = right.createdAt.getTime() - left.createdAt.getTime()
      if (createdDiff !== 0) return createdDiff
      return left.qualityWarnings.length - right.qualityWarnings.length
    })
    .slice(0, options.reviewLimit ?? 50)
    .map((observation) => ({
      auditId: observation.auditId,
      createdAt: observation.createdAt.toISOString(),
      groupId: observation.groupId,
      opportunityId: observation.opportunityId,
      score: observation.score,
      candidateText: observation.candidateText ?? '',
      triggerTextPreview: observation.triggerTextPreview,
      gateReasons: observation.gateReasons,
      policyReasons: observation.policyReasons,
      primaryMessageType: observation.primaryMessageType,
      segmentTypes: observation.segmentTypes,
      messageTypeCompleteness: observation.messageTypeCompleteness,
      tokenUsageState: observation.tokenUsageState,
      tokenUsage: observation.tokenUsage,
      qualityBucket: observation.qualityBucket,
      qualitySignals: observation.qualitySignals,
      qualityWarnings: observation.qualityWarnings,
    }))

  return {
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    observations,
    dailyByGroup: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date) || left.groupId - right.groupId),
    gateBreakdown: sortReasonBreakdown([...reasons.values()]),
    messageTypeBreakdown,
    qualityBuckets,
    tokenUsage,
    reviewQueue,
  }
}

export async function collectProactiveCandidateMetrics(
  options: ProactiveCandidateReportOptions,
  db?: ProactiveCandidateMetricsDb,
): Promise<ProactiveCandidateMetrics> {
  const metricsDb = db ?? (await import('../database/client.js')).prisma
  const auditRows = await metricsDb.replyAudit.findMany({
    where: {
      auditKind: 'proactive_candidate',
      createdAt: {
        gte: options.from,
        lt: options.to,
      },
      ...(options.groupId !== undefined ? { groupId: BigInt(options.groupId) } : {}),
    },
    orderBy: { createdAt: 'desc' },
    ...(options.maxAudits !== undefined ? { take: options.maxAudits } : {}),
  })

  const messageRowIds = new Set<number>()
  for (const row of auditRows) {
    const payload = isRecord(row.payload) ? row.payload : {}
    const triggerMessageRowId = asNumber(payload.triggerMessageRowId)
    const inferredMessageRowId = triggerMessageRowId ?? inferMessageRowIdFromOpportunityId(row.opportunityId)
    if (inferredMessageRowId !== undefined) messageRowIds.add(inferredMessageRowId)
  }

  const messageRows = messageRowIds.size > 0
    ? await metricsDb.message.findMany({
        where: { id: { in: [...messageRowIds] } },
        select: {
          id: true,
          groupId: true,
          messageId: true,
          senderId: true,
          senderNickname: true,
          senderGroupNickname: true,
          content: true,
          searchText: true,
          resolvedText: true,
          createdAt: true,
        },
      })
    : []

  const messageById = new Map(messageRows.map((row) => [row.id, row]))
  const observations = auditRows.map((row) => normalizeProactiveCandidateAudit(row, messageById))
  return buildProactiveCandidateMetrics(observations, options)
}

function markdownTable(headers: string[], rows: (string | number)[][]): string {
  if (rows.length === 0) return '_No rows._'
  const header = `| ${headers.join(' | ')} |`
  const divider = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.map((item) => String(item).replace(/\|/g, '\\|')).join(' | ')} |`)
  return [header, divider, ...body].join('\n')
}

export function formatProactiveCandidateMetricsMarkdown(metrics: ProactiveCandidateMetrics): string {
  const lines = [
    '# Proactive Candidate Report',
    '',
    `Window: ${metrics.from} to ${metrics.to}`,
    '',
    '## Daily By Group',
    '',
    markdownTable(
      ['date', 'groupId', 'total', 'candidate', 'gate', 'policy', 'no_candidate', 'unknown', 'tokenCaptured', 'tokenUnknown', 'tokens'],
      metrics.dailyByGroup.map((row) => [
        row.date,
        row.groupId,
        row.totalAudits,
        row.candidateGenerated,
        row.gateSuppressed,
        row.policySuppressed,
        row.noCandidate,
        row.unknown,
        row.tokenUsageCaptured,
        row.tokenUsageUnknown,
        row.totalTokens,
      ]),
    ),
    '',
    '## Gate And Policy Breakdown',
    '',
    markdownTable(
      ['kind', 'reason', 'count'],
      metrics.gateBreakdown.map((row) => [row.kind, row.reason, row.count]),
    ),
    '',
    '## Message Type Breakdown',
    '',
    markdownTable(
      ['primary', 'segments', 'total', 'candidate', 'suppressed', 'no_candidate', 'captured', 'inferred', 'unknown'],
      metrics.messageTypeBreakdown.map((row) => [
        row.primaryMessageType,
        row.segmentTypeSet,
        row.total,
        row.candidateGenerated,
        row.suppressed,
        row.noCandidate,
        row.capturedCount,
        row.inferredCount,
        row.unknownCount,
      ]),
    ),
    '',
    '## Token Usage',
    '',
    markdownTable(
      ['captured', 'unknown', 'notApplicable', 'prompt', 'completion', 'total', 'calls'],
      [[
        metrics.tokenUsage.captured,
        metrics.tokenUsage.unknown,
        metrics.tokenUsage.notApplicable,
        metrics.tokenUsage.promptTokens,
        metrics.tokenUsage.completionTokens,
        metrics.tokenUsage.totalTokens,
        metrics.tokenUsage.calls,
      ]],
    ),
    '',
    '## Quality Buckets',
    '',
    markdownTable(
      ['bucket', 'count'],
      Object.entries(metrics.qualityBuckets).map(([bucket, count]) => [bucket, count]),
    ),
    '',
    '## Review Queue',
    '',
    markdownTable(
      ['createdAt', 'groupId', 'score', 'type', 'tokenState', 'warnings', 'trigger', 'candidate'],
      metrics.reviewQueue.map((item) => [
        item.createdAt,
        item.groupId,
        item.score ?? '',
        item.primaryMessageType,
        item.tokenUsageState,
        item.qualityWarnings.join(','),
        item.triggerTextPreview ?? '',
        preview(item.candidateText, 80) ?? '',
      ]),
    ),
  ]

  return `${lines.join('\n')}\n`
}

export function formatProactiveCandidateMetricsCsv(metrics: ProactiveCandidateMetrics): string {
  const rows = [
    ['date', 'groupId', 'totalAudits', 'candidateGenerated', 'gateSuppressed', 'policySuppressed', 'noCandidate', 'unknown', 'totalTokens'],
    ...metrics.dailyByGroup.map((row) => [
      row.date,
      String(row.groupId),
      String(row.totalAudits),
      String(row.candidateGenerated),
      String(row.gateSuppressed),
      String(row.policySuppressed),
      String(row.noCandidate),
      String(row.unknown),
      String(row.totalTokens),
    ]),
  ]

  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'
}
