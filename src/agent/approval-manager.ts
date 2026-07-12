import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { BotOwner } from '../config/index.js'

export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'cancelled' | 'expired'

export interface ApprovalRequest {
  id: string
  toolName: string
  argsHash: string
  reason: string
  status: ApprovalStatus
  createdAt: Date
  expiresAt: Date
  approvedAt?: Date
  approvedByMessageRowId?: number
  consumedAt?: Date
  cancelledAt?: Date
}

export interface ApprovalEvidence {
  rowId: number
  sceneKind: string
  sceneExternalId: string
  senderId: bigint
  text: string
  sentAt: Date
}

export interface ApprovalManager {
  authorize(input: { toolName: string; args: unknown; reason: string }):
    | { allowed: true; approvalId: string }
    | { allowed: false; code: 'approval_required' | 'owner_not_configured'; request?: ApprovalRequest }
  approve(input: { approvalId: string; messageRowId: number }): Promise<ApprovalRequest>
  cancel(approvalId: string): boolean
  get(approvalId: string): ApprovalRequest | undefined
  list(): ApprovalRequest[]
}

interface StoredApproval extends Omit<
  ApprovalRequest,
  'createdAt' | 'expiresAt' | 'approvedAt' | 'consumedAt' | 'cancelledAt'
> {
  createdAt: string
  expiresAt: string
  approvedAt?: string
  consumedAt?: string
  cancelledAt?: string
}

interface StoredApprovalFile {
  schemaVersion: 1
  approvals: StoredApproval[]
}

export interface CreateApprovalManagerInput {
  path: string
  owner: BotOwner | null
  loadEvidence: (rowId: number) => Promise<ApprovalEvidence | null>
  now?: () => Date
  idFactory?: () => string
  ttlMs?: number
}

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000
const MAX_STORED_APPROVALS = 200

export function createApprovalManager(input: CreateApprovalManagerInput): ApprovalManager {
  const now = input.now ?? (() => new Date())
  const idFactory = input.idFactory ?? (() => `apr_${randomUUID()}`)
  const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
  const approvals = new Map(loadApprovals(input.path).map((approval) => [approval.id, approval]))

  function expire(reference = now()): boolean {
    let changed = false
    for (const approval of approvals.values()) {
      if (
        (approval.status === 'pending' || approval.status === 'approved')
        && approval.expiresAt.getTime() <= reference.getTime()
      ) {
        approval.status = 'expired'
        changed = true
      }
    }
    return changed
  }

  function persist(): void {
    const ordered = [...approvals.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, MAX_STORED_APPROVALS)
    approvals.clear()
    for (const approval of ordered) approvals.set(approval.id, approval)
    persistApprovals(input.path, ordered)
  }

  return {
    authorize(request) {
      const reference = now()
      const changed = expire(reference)
      if (!input.owner) {
        if (changed) persist()
        return { allowed: false, code: 'owner_not_configured' }
      }
      const argsHash = hashApprovalArgs(request.toolName, request.args)
      const existing = [...approvals.values()]
        .filter((approval) => approval.toolName === request.toolName && approval.argsHash === argsHash)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .find((approval) => approval.status === 'approved' || approval.status === 'pending')

      if (existing?.status === 'approved') {
        existing.status = 'consumed'
        existing.consumedAt = reference
        persist()
        return { allowed: true, approvalId: existing.id }
      }
      if (existing) {
        if (changed) persist()
        return { allowed: false, code: 'approval_required', request: cloneApproval(existing) }
      }

      const approval: ApprovalRequest = {
        id: idFactory(),
        toolName: request.toolName,
        argsHash,
        reason: request.reason,
        status: 'pending',
        createdAt: reference,
        expiresAt: new Date(reference.getTime() + ttlMs),
      }
      approvals.set(approval.id, approval)
      persist()
      return { allowed: false, code: 'approval_required', request: cloneApproval(approval) }
    },

    async approve({ approvalId, messageRowId }) {
      const reference = now()
      if (expire(reference)) persist()
      const approval = approvals.get(approvalId)
      if (!approval) throw new Error(`approval not found: ${approvalId}`)
      if (approval.status !== 'pending') throw new Error(`approval is not pending: ${approval.status}`)
      if (!input.owner) throw new Error('owner is not configured')
      const evidence = await input.loadEvidence(messageRowId)
      if (!evidence) throw new Error(`approval evidence message not found: ${messageRowId}`)
      if (
        evidence.sceneKind !== 'qq_private'
        || evidence.sceneExternalId !== String(input.owner.qq)
        || evidence.senderId !== BigInt(input.owner.qq)
      ) {
        throw new Error('approval evidence must be a private message from the configured owner')
      }
      if (evidence.sentAt.getTime() < approval.createdAt.getTime()) {
        throw new Error('approval evidence predates the approval request')
      }
      if (evidence.sentAt.getTime() > approval.expiresAt.getTime()) {
        throw new Error('approval evidence was sent after the approval request expired')
      }
      const expected = `批准 ${approval.id}`
      if (evidence.text.trim() !== expected) {
        throw new Error(`approval evidence text must exactly equal: ${expected}`)
      }
      approval.status = 'approved'
      approval.approvedAt = reference
      approval.approvedByMessageRowId = messageRowId
      persist()
      return cloneApproval(approval)
    },

    cancel(approvalId) {
      const approval = approvals.get(approvalId)
      if (!approval || (approval.status !== 'pending' && approval.status !== 'approved')) return false
      approval.status = 'cancelled'
      approval.cancelledAt = now()
      persist()
      return true
    },

    get(approvalId) {
      if (expire()) persist()
      const approval = approvals.get(approvalId)
      return approval ? cloneApproval(approval) : undefined
    },

    list() {
      if (expire()) persist()
      return [...approvals.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(cloneApproval)
    },
  }
}

export function hashApprovalArgs(toolName: string, args: unknown): string {
  return createHash('sha256').update(`${toolName}\n${stableStringify(args)}`).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(',')}}`
}

function loadApprovals(path: string): ApprovalRequest[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(raw) as StoredApprovalFile
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.approvals)) {
    throw new Error(`Unsupported approval state schema: ${path}`)
  }
  return parsed.approvals.map((approval) => {
    const { createdAt, expiresAt, approvedAt, consumedAt, cancelledAt, ...rest } = approval
    return {
      ...rest,
      createdAt: parseDate(createdAt, path),
      expiresAt: parseDate(expiresAt, path),
      ...(approvedAt ? { approvedAt: parseDate(approvedAt, path) } : {}),
      ...(consumedAt ? { consumedAt: parseDate(consumedAt, path) } : {}),
      ...(cancelledAt ? { cancelledAt: parseDate(cancelledAt, path) } : {}),
    }
  })
}

function persistApprovals(path: string, approvals: readonly ApprovalRequest[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload: StoredApprovalFile = {
    schemaVersion: 1,
    approvals: approvals.map((approval) => ({
      id: approval.id,
      toolName: approval.toolName,
      argsHash: approval.argsHash,
      reason: approval.reason,
      status: approval.status,
      createdAt: formatBeijingIso(approval.createdAt),
      expiresAt: formatBeijingIso(approval.expiresAt),
      ...(approval.approvedAt ? { approvedAt: formatBeijingIso(approval.approvedAt) } : {}),
      ...(approval.approvedByMessageRowId != null
        ? { approvedByMessageRowId: approval.approvedByMessageRowId }
        : {}),
      ...(approval.consumedAt ? { consumedAt: formatBeijingIso(approval.consumedAt) } : {}),
      ...(approval.cancelledAt ? { cancelledAt: formatBeijingIso(approval.cancelledAt) } : {}),
    })),
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function parseDate(value: string, path: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid approval timestamp in ${path}: ${value}`)
  return date
}

function cloneApproval(approval: ApprovalRequest): ApprovalRequest {
  return structuredClone(approval)
}
