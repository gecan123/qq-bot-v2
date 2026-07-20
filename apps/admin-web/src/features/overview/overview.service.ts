import { overviewSnapshotSchema, type OverviewSnapshot } from './overview.schema.js'

export interface OverviewDb {
  botAgentLedgerEntry: {
    count(): Promise<number>
    findFirst(input: object): Promise<{ id: bigint; entryType: string; createdAt: Date } | null>
  }
  botAgentRuntimeState: {
    findUnique(input: object): Promise<{
      qqConversationFocus: unknown
      lastWakeAt: Date | null
      updatedAt: Date
    } | null>
  }
  botAgentGoal: {
    findUnique(input: object): Promise<{
      goalId: string
      objective: string
      status: string
      tokensUsed: number
      tokenBudget: number | null
      revision: number
      updatedAt: Date
    } | null>
  }
  agentTokenUsage: {
    findFirst(input: object): Promise<{
      ts: Date
      model: string
      inputTokens: number | null
      cachedTokens: number | null
      outputTokens: number | null
      cacheHitRate: number | null
    } | null>
  }
  agentToolCall: { count(input: object): Promise<number> }
}

export async function loadOverviewSnapshot(
  db: OverviewDb,
  now: Date = new Date(),
): Promise<OverviewSnapshot> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const [entryCount, head, runtime, goal, usage, calls, failed] = await Promise.all([
    db.botAgentLedgerEntry.count(),
    db.botAgentLedgerEntry.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true, entryType: true, createdAt: true },
    }),
    db.botAgentRuntimeState.findUnique({
      where: { id: 1 },
      select: { qqConversationFocus: true, lastWakeAt: true, updatedAt: true },
    }),
    db.botAgentGoal.findUnique({
      where: { id: 1 },
      select: {
        goalId: true,
        objective: true,
        status: true,
        tokensUsed: true,
        tokenBudget: true,
        revision: true,
        updatedAt: true,
      },
    }),
    db.agentTokenUsage.findFirst({
      where: { operation: 'agent.chat' },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      select: {
        ts: true,
        model: true,
        inputTokens: true,
        cachedTokens: true,
        outputTokens: true,
        cacheHitRate: true,
      },
    }),
    db.agentToolCall.count({ where: { ts: { gte: since } } }),
    db.agentToolCall.count({ where: { ts: { gte: since }, ok: false } }),
  ])

  const warnings: string[] = []
  const focus = parseFocus(runtime?.qqConversationFocus, warnings)

  return overviewSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    readOnly: true,
    ledger: {
      entryCount,
      headEntryId: head?.id.toString() ?? null,
      latestEntryType: head?.entryType ?? null,
      latestEntryAt: head?.createdAt.toISOString() ?? null,
    },
    runtime: {
      available: runtime !== null,
      updatedAt: runtime?.updatedAt.toISOString() ?? null,
      lastWakeAt: runtime?.lastWakeAt?.toISOString() ?? null,
      focus,
    },
    goal: goal === null ? null : {
      ...goal,
      updatedAt: goal.updatedAt.toISOString(),
    },
    latestAgentUsage: usage === null ? null : {
      ...usage,
      ts: usage.ts.toISOString(),
      cacheHitRate: usage.cacheHitRate ?? deriveCacheHitRate(usage),
    },
    tools24h: { calls, failed },
    warnings,
  })
}

function parseFocus(
  value: unknown,
  warnings: string[],
): OverviewSnapshot['runtime']['focus'] {
  if (value === null || value === undefined) return null

  if (typeof value === 'object') {
    const focus = value as Record<string, unknown>
    if (focus.type === 'group' && isPositiveSafeInteger(focus.groupId)) {
      return { type: 'group', id: String(focus.groupId) }
    }
    if (focus.type === 'private' && isPositiveSafeInteger(focus.userId)) {
      return { type: 'private', id: String(focus.userId) }
    }
  }

  warnings.push('runtime.qqConversationFocus invalid')
  return null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function deriveCacheHitRate(usage: {
  inputTokens: number | null
  cachedTokens: number | null
}): number | null {
  if (usage.inputTokens === null || usage.inputTokens <= 0 || usage.cachedTokens === null) {
    return null
  }
  return Math.min(1, Math.max(0, usage.cachedTokens / usage.inputTokens))
}
