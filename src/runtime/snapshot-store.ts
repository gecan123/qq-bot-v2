import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import type {
  CreateRootRuntimeSnapshotInput,
  RootRuntimeContextSnapshot,
  RuntimeContextMessage,
  RootRuntimeSessionSnapshot,
  RootRuntimeSnapshotRecord,
} from './types.js'

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
      unreadMessages: [],
      senderContinuities: [],
      proactiveCandidates: [],
      recentObservedMessageRowIds: [],
      lastWakeAt: null,
    }
  }

  const parsed = value as Partial<RootRuntimeSessionSnapshot>
  const focusedStateId = typeof parsed.focusedStateId === 'string' ? parsed.focusedStateId : 'portal'
  const stateStack = Array.isArray(parsed.stateStack) && parsed.stateStack.every((item) => typeof item === 'string')
    ? parsed.stateStack
    : [focusedStateId]

    return {
      focusedStateId,
      stateStack,
      unreadMessages: Array.isArray(parsed.unreadMessages) ? parsed.unreadMessages : [],
      senderContinuities: Array.isArray(parsed.senderContinuities) ? parsed.senderContinuities : [],
      proactiveCandidates: Array.isArray(parsed.proactiveCandidates) ? parsed.proactiveCandidates : [],
      recentObservedMessageRowIds: Array.isArray(parsed.recentObservedMessageRowIds)
        ? parsed.recentObservedMessageRowIds.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
        : [],
      lastWakeAt: typeof parsed.lastWakeAt === 'string' || parsed.lastWakeAt === null ? (parsed.lastWakeAt ?? null) : null,
    }
}

function mapRow(
  row: Awaited<ReturnType<typeof prisma.rootRuntimeSnapshot.findUnique>> extends infer T
    ? T extends null ? never : T
    : never,
): RootRuntimeSnapshotRecord {
  return {
    id: row.id,
    runtimeKey: row.runtimeKey,
    groupId: Number(row.groupId),
    schemaVersion: row.schemaVersion,
    contextSnapshot: parseContextSnapshot(row.contextSnapshot),
    sessionSnapshot: parseSessionSnapshot(row.sessionSnapshot),
    lastObservedMessageRowId: row.lastObservedMessageRowId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listRootRuntimeSnapshotsByGroupIds(groupIds: number[]): Promise<RootRuntimeSnapshotRecord[]> {
  if (groupIds.length === 0) return []

  const rows = await prisma.rootRuntimeSnapshot.findMany({
    where: {
      groupId: { in: groupIds.map(BigInt) },
    },
    orderBy: [
      { groupId: 'asc' },
      { updatedAt: 'desc' },
    ],
  })

  return rows.map((row) => mapRow(row))
}

export async function getRootRuntimeSnapshotByRuntimeKey(runtimeKey: string): Promise<RootRuntimeSnapshotRecord | null> {
  const row = await prisma.rootRuntimeSnapshot.findUnique({
    where: { runtimeKey },
  })

  return row ? mapRow(row) : null
}

export async function upsertRootRuntimeSnapshot(
  input: CreateRootRuntimeSnapshotInput,
): Promise<RootRuntimeSnapshotRecord> {
  const row = await prisma.rootRuntimeSnapshot.upsert({
    where: {
      runtimeKey: input.runtimeKey,
    },
    create: {
      runtimeKey: input.runtimeKey,
      groupId: BigInt(input.groupId),
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) ?? { messages: [] },
      sessionSnapshot: sanitizeJsonValue(input.sessionSnapshot) ?? {},
      lastObservedMessageRowId: input.lastObservedMessageRowId ?? null,
    },
    update: {
      groupId: BigInt(input.groupId),
      schemaVersion: input.schemaVersion,
      contextSnapshot: sanitizeJsonValue(input.contextSnapshot) ?? { messages: [] },
      sessionSnapshot: sanitizeJsonValue(input.sessionSnapshot) ?? {},
      lastObservedMessageRowId: input.lastObservedMessageRowId ?? null,
    },
  })

  return mapRow(row)
}
