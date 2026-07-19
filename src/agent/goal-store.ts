import { randomUUID } from 'node:crypto'
import { Prisma, type BotAgentGoal as BotAgentGoalRow } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'

export const MAX_GOAL_OBJECTIVE_CHARS = 4_000
export const MAX_GOAL_TOKEN_BUDGET = 10_000_000
export const GOAL_BLOCKED_TURN_THRESHOLD = 3
export const DEFAULT_SELF_GOAL_TOKEN_BUDGET = 1_000_000
export const SELF_GOAL_CREATE_COOLDOWN_MS = 60_000
export const SELF_GOAL_WINDOW_MS = 24 * 60 * 60 * 1_000
export const MAX_SELF_GOALS_PER_WINDOW = 64

export type AgentGoalOrigin = 'owner' | 'self'

export type AgentGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budget_limited'
  | 'usage_limited'
  | 'complete'
  | 'cancelled'
  | 'abandoned'

export interface GoalCommitment {
  action: string
  reason: string
  expectedEvidence: string
}

export interface AgentGoal {
  goalId: string
  objective: string
  origin: AgentGoalOrigin
  motivation: string | null
  completionCriteria: string[]
  currentCommitment: GoalCommitment | null
  status: AgentGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  roundsUsed: number
  revision: number
  sourceMessageRowId: number | null
  lastControlMessageRowId: number | null
  blockerKey: string | null
  blockerTurns: number
  lastBlockerRound: number | null
  blockedReason: string | null
  completionEvidence: string[] | null
  selfGoalWindowStartedAt: Date | null
  selfGoalWindowCount: number
  lastSelfGoalCreatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type GoalControlCommand =
  | { action: 'status' }
  | { action: 'set'; objective: string; tokenBudget: number | null }
  | { action: 'pause' }
  | { action: 'resume'; tokenBudget: number | null }
  | { action: 'clear' }

export interface GoalMutationResult {
  ok: boolean
  code:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'duplicate'
    | 'no_goal'
    | 'unfinished_goal'
    | 'invalid_transition'
    | 'budget_increase_required'
    | 'stale_goal'
    | 'blocker_recorded'
    | 'blocked'
    | 'replanned'
    | 'self_goal_cooldown'
    | 'self_goal_daily_limit'
    | 'owner_goal_active'
  goal: AgentGoal | null
  error?: string
}

export interface GoalStore {
  get(): Promise<AgentGoal | null>
  applyControl(input: {
    messageRowId: number
    command: GoalControlCommand
  }): Promise<GoalMutationResult>
  complete(input: { goalId: string; evidence: string[] }): Promise<GoalMutationResult>
  reportBlocker(input: {
    goalId: string
    roundIndex: number
    blockerKey: string
    reason: string
  }): Promise<GoalMutationResult>
  accountRound(input: {
    goalId: string
    tokensUsed: number
    timeUsedSeconds: number
  }): Promise<GoalMutationResult>
  markUsageLimited(input: { goalId: string; reason: string }): Promise<GoalMutationResult>
  createSelf(input: {
    objective: string
    motivation: string
    completionCriteria: string[]
    currentCommitment: GoalCommitment
    tokenBudget?: number
  }): Promise<GoalMutationResult>
  replan(input: {
    goalId: string
    currentCommitment: GoalCommitment
  }): Promise<GoalMutationResult>
  abandonSelf(input: { goalId: string; reason: string }): Promise<GoalMutationResult>
}

type Mutator = (current: AgentGoal | null, now: Date) => GoalMutationResult

export function createBotGoalStore(): GoalStore {
  let mutationChain = Promise.resolve()

  async function mutate(mutator: Mutator): Promise<GoalMutationResult> {
    const operation = mutationChain.then(async () => prisma.$transaction(async (tx) => {
      const currentRow = await tx.botAgentGoal.findUnique({ where: { id: 1 } })
      const current = currentRow ? fromRow(currentRow) : null
      const result = mutator(current, new Date())
      if (result.goal && result.goal !== current) {
        await persistGoal(tx, result.goal)
      }
      return result
    }))
    mutationChain = operation.then(() => undefined, () => undefined)
    return operation
  }

  return {
    async get() {
      const row = await prisma.botAgentGoal.findUnique({ where: { id: 1 } })
      return row ? fromRow(row) : null
    },
    applyControl(input) {
      return mutate((current, now) => applyControlMutation(current, input, now))
    },
    complete(input) {
      return mutate((current, now) => completeMutation(current, input, now))
    },
    reportBlocker(input) {
      return mutate((current, now) => reportBlockerMutation(current, input, now))
    },
    accountRound(input) {
      return mutate((current, now) => accountRoundMutation(current, input, now))
    },
    markUsageLimited(input) {
      return mutate((current, now) => markUsageLimitedMutation(current, input, now))
    },
    createSelf(input) {
      return mutate((current, now) => createSelfMutation(current, input, now))
    },
    replan(input) {
      return mutate((current, now) => replanMutation(current, input, now))
    },
    abandonSelf(input) {
      return mutate((current, now) => abandonSelfMutation(current, input, now))
    },
  }
}

export function createInMemoryGoalStore(
  initial: AgentGoal | null = null,
  options: { now?: () => Date } = {},
): GoalStore {
  let current = initial ? cloneGoal(initial) : null
  const mutate = async (mutator: Mutator) => {
    const result = mutator(current, options.now?.() ?? new Date())
    if (result.goal && result.goal !== current) current = cloneGoal(result.goal)
    return cloneResult(result)
  }
  return {
    async get() {
      return current ? cloneGoal(current) : null
    },
    applyControl(input) {
      return mutate((goal, now) => applyControlMutation(goal, input, now))
    },
    complete(input) {
      return mutate((goal, now) => completeMutation(goal, input, now))
    },
    reportBlocker(input) {
      return mutate((goal, now) => reportBlockerMutation(goal, input, now))
    },
    accountRound(input) {
      return mutate((goal, now) => accountRoundMutation(goal, input, now))
    },
    markUsageLimited(input) {
      return mutate((goal, now) => markUsageLimitedMutation(goal, input, now))
    },
    createSelf(input) {
      return mutate((goal, now) => createSelfMutation(goal, input, now))
    },
    replan(input) {
      return mutate((goal, now) => replanMutation(goal, input, now))
    },
    abandonSelf(input) {
      return mutate((goal, now) => abandonSelfMutation(goal, input, now))
    },
  }
}

function applyControlMutation(
  current: AgentGoal | null,
  input: { messageRowId: number; command: GoalControlCommand },
  now: Date,
): GoalMutationResult {
  if (current?.lastControlMessageRowId != null && input.messageRowId <= current.lastControlMessageRowId) {
    return result(true, 'duplicate', current)
  }
  if (input.command.action === 'status') return result(true, 'unchanged', current)

  if (input.command.action === 'set') {
    if (current && isUnfinished(current.status) && current.origin === 'owner') {
      const next = { ...current, lastControlMessageRowId: input.messageRowId, updatedAt: now }
      return result(false, 'unfinished_goal', next, '已有未完成 goal；先 /goal clear，或等待它完成。')
    }
    const goal = createGoal({
      current,
      objective: input.command.objective,
      origin: 'owner',
      motivation: null,
      completionCriteria: [],
      currentCommitment: null,
      tokenBudget: input.command.tokenBudget,
      sourceMessageRowId: input.messageRowId,
      lastControlMessageRowId: input.messageRowId,
      now,
    })
    return result(true, 'created', goal)
  }

  if (!current) return result(false, 'no_goal', null, '当前没有 goal。')
  const base = { ...current, lastControlMessageRowId: input.messageRowId, updatedAt: now }

  if (input.command.action === 'pause') {
    if (current.status === 'paused') return result(true, 'unchanged', base)
    if (current.status !== 'active') {
      return result(false, 'invalid_transition', base, `goal 状态 ${current.status} 不能 pause。`)
    }
    return result(true, 'updated', {
      ...base,
      status: 'paused',
      revision: current.revision + 1,
    })
  }

  if (input.command.action === 'resume') {
    if (!['active', 'paused', 'blocked', 'budget_limited', 'usage_limited'].includes(current.status)) {
      return result(false, 'invalid_transition', base, `goal 状态 ${current.status} 不能 resume。`)
    }
    const tokenBudget = input.command.tokenBudget ?? current.tokenBudget
    if (current.status === 'budget_limited' && tokenBudget != null && tokenBudget <= current.tokensUsed) {
      return result(
        false,
        'budget_increase_required',
        base,
        `恢复 budget_limited goal 时，新预算必须大于已用 ${current.tokensUsed} tokens。`,
      )
    }
    const changed = current.status !== 'active' || tokenBudget !== current.tokenBudget
    return result(true, changed ? 'updated' : 'unchanged', {
      ...base,
      status: 'active',
      tokenBudget,
      revision: changed ? current.revision + 1 : current.revision,
      blockerKey: null,
      blockerTurns: 0,
      lastBlockerRound: null,
      blockedReason: null,
    })
  }

  if (current.status === 'cancelled') return result(true, 'unchanged', base)
  return result(true, 'updated', {
    ...base,
    status: 'cancelled',
    revision: current.revision + 1,
    currentCommitment: null,
  })
}

function completeMutation(
  current: AgentGoal | null,
  input: { goalId: string; evidence: string[] },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current, 'goalId 已过期或当前没有 goal。')
  }
  if (!['active', 'budget_limited'].includes(current.status)) {
    return result(false, 'invalid_transition', current, `goal 状态 ${current.status} 不能由 Agent 标记完成。`)
  }
  return result(true, 'updated', {
    ...current,
    status: 'complete',
    revision: current.revision + 1,
    completionEvidence: [...input.evidence],
    currentCommitment: null,
    blockerKey: null,
    blockerTurns: 0,
    lastBlockerRound: null,
    blockedReason: null,
    updatedAt: now,
  })
}

function reportBlockerMutation(
  current: AgentGoal | null,
  input: { goalId: string; roundIndex: number; blockerKey: string; reason: string },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current, 'goalId 已过期或当前没有 goal。')
  }
  if (current.status !== 'active') {
    return result(false, 'invalid_transition', current, `goal 状态 ${current.status} 不能报告 blocker。`)
  }
  const consecutive = current.blockerKey === input.blockerKey
    && current.lastBlockerRound === input.roundIndex - 1
  const blockerTurns = consecutive ? current.blockerTurns + 1 : 1
  const blocked = blockerTurns >= GOAL_BLOCKED_TURN_THRESHOLD
  const next: AgentGoal = {
    ...current,
    status: blocked ? 'blocked' : 'active',
    revision: blocked ? current.revision + 1 : current.revision,
    blockerKey: input.blockerKey,
    blockerTurns,
    lastBlockerRound: input.roundIndex,
    blockedReason: input.reason,
    updatedAt: now,
  }
  return result(true, blocked ? 'blocked' : 'blocker_recorded', next)
}

function accountRoundMutation(
  current: AgentGoal | null,
  input: { goalId: string; tokensUsed: number; timeUsedSeconds: number },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current)
  }
  const tokensUsed = safeAdd(current.tokensUsed, input.tokensUsed)
  const timeUsedSeconds = safeAdd(current.timeUsedSeconds, input.timeUsedSeconds)
  const roundsUsed = safeAdd(current.roundsUsed, 1)
  const becomesBudgetLimited = current.status === 'active'
    && current.tokenBudget != null
    && tokensUsed >= current.tokenBudget
  const next: AgentGoal = {
    ...current,
    tokensUsed,
    timeUsedSeconds,
    roundsUsed,
    status: becomesBudgetLimited ? 'budget_limited' : current.status,
    revision: becomesBudgetLimited ? current.revision + 1 : current.revision,
    updatedAt: now,
  }
  return result(true, becomesBudgetLimited ? 'updated' : 'unchanged', next)
}

function markUsageLimitedMutation(
  current: AgentGoal | null,
  input: { goalId: string; reason: string },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current)
  }
  if (current.status !== 'active') {
    return result(false, 'invalid_transition', current, `goal 状态 ${current.status} 不能转 usage_limited。`)
  }
  return result(true, 'updated', {
    ...current,
    status: 'usage_limited',
    revision: current.revision + 1,
    blockedReason: input.reason,
    updatedAt: now,
  })
}

function createSelfMutation(
  current: AgentGoal | null,
  input: {
    objective: string
    motivation: string
    completionCriteria: string[]
    currentCommitment: GoalCommitment
    tokenBudget?: number
  },
  now: Date,
): GoalMutationResult {
  if (current && isUnfinished(current.status)) {
    return result(
      false,
      current.origin === 'owner' ? 'owner_goal_active' : 'unfinished_goal',
      current,
      current.origin === 'owner'
        ? 'owner goal 正在进行，不能创建 self goal。'
        : '已有未完成 self goal。',
    )
  }

  const governor = selfGoalGovernor(current, now)
  if (
    governor.lastCreatedAt
    && now.getTime() - governor.lastCreatedAt.getTime() < SELF_GOAL_CREATE_COOLDOWN_MS
  ) {
    return result(false, 'self_goal_cooldown', current, 'self goal 创建过于频繁，请先继续普通自主活动。')
  }
  if (governor.count >= MAX_SELF_GOALS_PER_WINDOW) {
    return result(false, 'self_goal_daily_limit', current, '24 小时 self goal 保险丝已触发。')
  }

  return result(true, 'created', createGoal({
    current,
    objective: input.objective,
    origin: 'self',
    motivation: input.motivation,
    completionCriteria: input.completionCriteria,
    currentCommitment: input.currentCommitment,
    tokenBudget: input.tokenBudget ?? DEFAULT_SELF_GOAL_TOKEN_BUDGET,
    sourceMessageRowId: null,
    lastControlMessageRowId: current?.lastControlMessageRowId ?? null,
    now,
    selfGoalWindowStartedAt: governor.windowStartedAt,
    selfGoalWindowCount: governor.count + 1,
    lastSelfGoalCreatedAt: now,
  }))
}

function replanMutation(
  current: AgentGoal | null,
  input: { goalId: string; currentCommitment: GoalCommitment },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current, 'goalId 已过期或当前没有 goal。')
  }
  if (current.status !== 'active') {
    return result(false, 'invalid_transition', current, `goal 状态 ${current.status} 不能 replan。`)
  }
  if (equalCommitment(current.currentCommitment, input.currentCommitment)) {
    return result(true, 'unchanged', current)
  }
  return result(true, 'replanned', {
    ...current,
    currentCommitment: cloneCommitment(input.currentCommitment),
    revision: current.revision + 1,
    blockerKey: null,
    blockerTurns: 0,
    lastBlockerRound: null,
    blockedReason: null,
    updatedAt: now,
  })
}

function abandonSelfMutation(
  current: AgentGoal | null,
  input: { goalId: string; reason: string },
  now: Date,
): GoalMutationResult {
  if (!current || current.goalId !== input.goalId) {
    return result(false, 'stale_goal', current, 'goalId 已过期或当前没有 goal。')
  }
  if (current.origin !== 'self') {
    return result(false, 'owner_goal_active', current, 'Agent 不能放弃 owner goal。')
  }
  if (!isUnfinished(current.status)) {
    return result(false, 'invalid_transition', current, `goal 状态 ${current.status} 不能 abandon。`)
  }
  return result(true, 'updated', {
    ...current,
    status: 'abandoned',
    revision: current.revision + 1,
    currentCommitment: null,
    blockedReason: input.reason,
    updatedAt: now,
  })
}

function createGoal(input: {
  current: AgentGoal | null
  objective: string
  origin: AgentGoalOrigin
  motivation: string | null
  completionCriteria: string[]
  currentCommitment: GoalCommitment | null
  tokenBudget: number | null
  sourceMessageRowId: number | null
  lastControlMessageRowId: number | null
  now: Date
  selfGoalWindowStartedAt?: Date | null
  selfGoalWindowCount?: number
  lastSelfGoalCreatedAt?: Date | null
}): AgentGoal {
  return {
    goalId: randomUUID(),
    objective: input.objective,
    origin: input.origin,
    motivation: input.motivation,
    completionCriteria: [...input.completionCriteria],
    currentCommitment: input.currentCommitment ? cloneCommitment(input.currentCommitment) : null,
    status: 'active',
    tokenBudget: input.tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    roundsUsed: 0,
    revision: (input.current?.revision ?? 0) + 1,
    sourceMessageRowId: input.sourceMessageRowId,
    lastControlMessageRowId: input.lastControlMessageRowId,
    blockerKey: null,
    blockerTurns: 0,
    lastBlockerRound: null,
    blockedReason: null,
    completionEvidence: null,
    selfGoalWindowStartedAt: input.selfGoalWindowStartedAt
      ?? input.current?.selfGoalWindowStartedAt
      ?? null,
    selfGoalWindowCount: input.selfGoalWindowCount
      ?? input.current?.selfGoalWindowCount
      ?? 0,
    lastSelfGoalCreatedAt: input.lastSelfGoalCreatedAt
      ?? input.current?.lastSelfGoalCreatedAt
      ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function selfGoalGovernor(current: AgentGoal | null, now: Date): {
  windowStartedAt: Date
  count: number
  lastCreatedAt: Date | null
} {
  const currentStart = current?.selfGoalWindowStartedAt ?? null
  const expired = !currentStart || now.getTime() - currentStart.getTime() >= SELF_GOAL_WINDOW_MS
  return {
    windowStartedAt: expired ? now : currentStart,
    count: expired ? 0 : current?.selfGoalWindowCount ?? 0,
    lastCreatedAt: current?.lastSelfGoalCreatedAt ?? null,
  }
}

function result(
  ok: boolean,
  code: GoalMutationResult['code'],
  goal: AgentGoal | null,
  error?: string,
): GoalMutationResult {
  return { ok, code, goal, ...(error ? { error } : {}) }
}

function isUnfinished(status: AgentGoalStatus): boolean {
  return !['complete', 'cancelled', 'abandoned'].includes(status)
}

function safeAdd(current: number, delta: number): number {
  const normalized = Number.isFinite(delta) ? Math.max(0, Math.floor(delta)) : 0
  return Math.min(2_147_483_647, current + normalized)
}

function cloneGoal(goal: AgentGoal): AgentGoal {
  return {
    ...goal,
    completionCriteria: [...goal.completionCriteria],
    currentCommitment: goal.currentCommitment ? cloneCommitment(goal.currentCommitment) : null,
    completionEvidence: goal.completionEvidence ? [...goal.completionEvidence] : null,
    selfGoalWindowStartedAt: goal.selfGoalWindowStartedAt
      ? new Date(goal.selfGoalWindowStartedAt)
      : null,
    lastSelfGoalCreatedAt: goal.lastSelfGoalCreatedAt
      ? new Date(goal.lastSelfGoalCreatedAt)
      : null,
    createdAt: new Date(goal.createdAt),
    updatedAt: new Date(goal.updatedAt),
  }
}

function cloneResult(value: GoalMutationResult): GoalMutationResult {
  return { ...value, goal: value.goal ? cloneGoal(value.goal) : null }
}

function fromRow(row: BotAgentGoalRow): AgentGoal {
  const rawEvidence = row.completionEvidence
  const rawCriteria = row.completionCriteria
  const rawCommitment = row.currentCommitment
  return {
    goalId: row.goalId,
    objective: row.objective,
    origin: row.origin as AgentGoalOrigin,
    motivation: row.motivation,
    completionCriteria: Array.isArray(rawCriteria)
      ? rawCriteria.filter((item): item is string => typeof item === 'string')
      : [],
    currentCommitment: parseCommitment(rawCommitment),
    status: row.status as AgentGoalStatus,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    timeUsedSeconds: row.timeUsedSeconds,
    roundsUsed: row.roundsUsed,
    revision: row.revision,
    sourceMessageRowId: row.sourceMessageRowId,
    lastControlMessageRowId: row.lastControlMessageRowId,
    blockerKey: row.blockerKey,
    blockerTurns: row.blockerTurns,
    lastBlockerRound: row.lastBlockerRound,
    blockedReason: row.blockedReason,
    completionEvidence: Array.isArray(rawEvidence)
      ? rawEvidence.filter((item): item is string => typeof item === 'string')
      : null,
    selfGoalWindowStartedAt: row.selfGoalWindowStartedAt,
    selfGoalWindowCount: row.selfGoalWindowCount,
    lastSelfGoalCreatedAt: row.lastSelfGoalCreatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function persistGoal(
  tx: Prisma.TransactionClient,
  goal: AgentGoal,
): Promise<void> {
  const data = {
    goalId: goal.goalId,
    objective: goal.objective,
    origin: goal.origin,
    motivation: goal.motivation,
    completionCriteria: goal.completionCriteria.length > 0
      ? goal.completionCriteria
      : Prisma.JsonNull,
    currentCommitment: goal.currentCommitment
      ? { ...goal.currentCommitment }
      : Prisma.JsonNull,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    roundsUsed: goal.roundsUsed,
    revision: goal.revision,
    sourceMessageRowId: goal.sourceMessageRowId,
    lastControlMessageRowId: goal.lastControlMessageRowId,
    blockerKey: goal.blockerKey,
    blockerTurns: goal.blockerTurns,
    lastBlockerRound: goal.lastBlockerRound,
    blockedReason: goal.blockedReason,
    completionEvidence: goal.completionEvidence ?? Prisma.JsonNull,
    selfGoalWindowStartedAt: goal.selfGoalWindowStartedAt,
    selfGoalWindowCount: goal.selfGoalWindowCount,
    lastSelfGoalCreatedAt: goal.lastSelfGoalCreatedAt,
    createdAt: goal.createdAt,
  }
  await tx.botAgentGoal.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  })
}

function parseCommitment(value: unknown): GoalCommitment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.action !== 'string'
    || typeof record.reason !== 'string'
    || typeof record.expectedEvidence !== 'string'
  ) return null
  return {
    action: record.action,
    reason: record.reason,
    expectedEvidence: record.expectedEvidence,
  }
}

function cloneCommitment(value: GoalCommitment): GoalCommitment {
  return { ...value }
}

function equalCommitment(left: GoalCommitment | null, right: GoalCommitment): boolean {
  return left != null
    && left.action === right.action
    && left.reason === right.reason
    && left.expectedEvidence === right.expectedEvidence
}
