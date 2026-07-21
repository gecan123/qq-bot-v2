import { overviewSnapshotSchema, type OverviewSnapshot } from './overview.schema.js'
import type {
  AgentActivitySurface,
  AgentActivitySurfaceReadResult,
} from '../../../../../src/agent/activity-surface.js'
import type { OverviewToolActivityInput } from './overview-tool-log.js'

export type OverviewActivityInput = AgentActivitySurfaceReadResult | { status: 'stale' }

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
      currentCommitment: unknown
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
}

const emptyToolActivity: OverviewToolActivityInput = {
  recentCalls: [],
  calls24h: 0,
  failed24h: 0,
  warnings: [],
}

export async function loadOverviewSnapshot(
  db: OverviewDb,
  now: Date = new Date(),
  activityInput: OverviewActivityInput = { status: 'missing' },
  toolActivity: OverviewToolActivityInput = emptyToolActivity,
): Promise<OverviewSnapshot> {
  const [entryCount, head, runtime, goal, usage] = await Promise.all([
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
        currentCommitment: true,
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
  ])

  const warnings: string[] = [...toolActivity.warnings]
  const focus = parseFocus(runtime?.qqConversationFocus, warnings)

  const activity = mapActivity(activityInput)
  if (activityInput.status === 'invalid') warnings.push('实时活动观察面无效。')
  if (activityInput.status === 'stale') warnings.push('实时活动观察面属于已停止或不可达的 Bot 进程。')

  return overviewSnapshotSchema.parse({
    schemaVersion: 2,
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
      currentCommitment: parseCommitment(goal.currentCommitment),
      updatedAt: goal.updatedAt.toISOString(),
    },
    activity,
    recentActions: toolActivity.recentCalls.map(row => ({
      id: row.toolCallId,
      at: row.ts,
      ...describeToolAction(row.toolName, row.argsSummary, row.error ?? null),
      ok: row.ok,
      durationMs: row.durationMs,
      sideEffect: row.sideEffect,
      toolName: row.toolName,
      toolCallId: row.toolCallId,
      roundIndex: row.roundIndex,
      argsSummary: row.argsSummary,
    })),
    latestAgentUsage: usage === null ? null : {
      ...usage,
      ts: usage.ts.toISOString(),
      cacheHitRate: usage.cacheHitRate ?? deriveCacheHitRate(usage),
    },
    tools24h: { calls: toolActivity.calls24h, failed: toolActivity.failed24h },
    warnings,
  })
}

function mapActivity(input: OverviewActivityInput): OverviewSnapshot['activity'] {
  if (input.status !== 'available') {
    return {
      available: false,
      sourceStatus: input.status,
      phase: 'unavailable',
      phaseStartedAt: null,
      roundIndex: null,
      detail: null,
      waitUntil: null,
      trigger: null,
      activeTools: [],
      lastCompleted: null,
    }
  }
  const surface: AgentActivitySurface = input.surface
  return {
    available: true,
    sourceStatus: 'available',
    phase: surface.phase,
    phaseStartedAt: surface.phaseStartedAt,
    roundIndex: surface.roundIndex,
    detail: surface.detail,
    waitUntil: surface.waitUntil,
    trigger: surface.trigger,
    activeTools: surface.activeTools,
    lastCompleted: surface.lastCompleted,
  }
}

function parseCommitment(
  value: unknown,
): NonNullable<OverviewSnapshot['goal']>['currentCommitment'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.action === 'string'
    && typeof record.reason === 'string'
    && typeof record.expectedEvidence === 'string'
    ? {
        action: record.action,
        reason: record.reason,
        expectedEvidence: record.expectedEvidence,
      }
    : null
}

function describeToolAction(
  toolName: string,
  args: unknown,
  error: string | null,
): { title: string; detail: string } {
  const record = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
  const action = text(record.action)
  const query = text(record.query) ?? text(record.q)
  const reason = text(record.reason)
  const tool = text(record.tool)
  switch (toolName) {
    case 'inbox':
      return { title: '读取了消息', detail: action ? `动作：${action}` : '检查了一个 QQ mailbox' }
    case 'send_message':
      return { title: '发送了 QQ 消息', detail: '已向当前显式打开的 QQ 会话发送内容' }
    case 'web_search':
      return { title: '搜索了网络信息', detail: query ? `关键词：${query}` : '执行了一次网络搜索' }
    case 'fetch_content':
      return { title: '读取了外部内容', detail: text(record.url) ?? text(record.ref) ?? '获取并解析了内容' }
    case 'browser':
      return { title: action === 'open' ? '打开了网页' : '操作了浏览器', detail: action ? `动作：${action}` : '完成了一次浏览器操作' }
    case 'qq_conversation':
      return { title: action === 'open' ? '切换了 QQ 会话' : '更新了 QQ 会话状态', detail: action ? `动作：${action}` : '更新了显式发送目标' }
    case 'goal':
      return { title: '更新了当前 Goal', detail: action ? `动作：${action}` : '读取或更新了持久 Goal' }
    case 'pause':
    case 'rest':
      return { title: '完成了一次短暂休息', detail: reason ?? '休息计时结束或被注意事件打断' }
    case 'background_task':
      return { title: '检查了后台任务', detail: action ? `动作：${action}` : '读取了后台任务状态或结果' }
    case 'invoke':
      return { title: tool ? `调用了 ${tool}` : '调用了渐进式工具', detail: error ?? '完成了一次 deferred tool 调用' }
    default:
      return { title: `调用了 ${toolName}`, detail: error ?? (action ? `动作：${action}` : '工具执行完成') }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 300) : null
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
