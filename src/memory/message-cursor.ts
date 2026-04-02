export interface MemoryRefreshCursor {
  lastProcessedMessageRowId: number | null
}

export interface CursorRefreshStart {
  mode: 'cursor'
  lastProcessedMessageRowId: number
}

export interface RecoveryRefreshStart {
  mode: 'recovery'
  since: Date
}

export type MemoryRefreshStart = CursorRefreshStart | RecoveryRefreshStart

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000

export function resolveMemoryRefreshStart(params: MemoryRefreshCursor & { now?: Date }): MemoryRefreshStart {
  if (params.lastProcessedMessageRowId !== null) {
    return {
      mode: 'cursor',
      lastProcessedMessageRowId: params.lastProcessedMessageRowId,
    }
  }

  const now = params.now ?? new Date()
  return {
    mode: 'recovery',
    since: new Date(now.getTime() - RECOVERY_WINDOW_MS),
  }
}

export function buildRecoveryWindowWhere(since: Date): {
  OR: Array<{ sentAt: { gte: Date } } | { sentAt: null; createdAt: { gte: Date } }>
} {
  return {
    OR: [
      { sentAt: { gte: since } },
      {
        sentAt: null,
        createdAt: { gte: since },
      },
    ],
  }
}
