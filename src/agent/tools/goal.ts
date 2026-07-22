import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { GoalCompletionJudge } from '../goal-completion-judge.js'
import {
  DEFAULT_SELF_GOAL_TOKEN_BUDGET,
  MAX_GOAL_TOKEN_BUDGET,
  type AgentGoal,
  type GoalStore,
} from '../goal-store.js'
import { createLogger } from '../../logger.js'

const log = createLogger('goal-tool')

const evidenceSchema = z.string().trim().min(1).max(500)
const commitmentSchema = z.object({
  action: z.string().trim().min(1).max(500)
    .describe('现在承诺执行的一个具体动作；写清对象和第一步，不写抽象方向。'),
  reason: z.string().trim().min(1).max(800)
    .describe('为什么当前选择这一步，而不是其他候选。'),
  expectedEvidence: z.string().trim().min(1).max(500)
    .describe('完成这一步后应出现的可检查结果或新证据。'),
})

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get').describe('读取当前持久 goal、状态、预算和使用量。'),
  }),
  z.object({
    action: z.literal('create_self').describe('没有未完成 goal 时，为自己创建一个持久目标。'),
    objective: z.string().trim().min(1).max(4_000)
      .describe('真正想持续推进的目标；写清对象和期望结果。'),
    motivation: z.string().trim().min(1).max(1_000)
      .describe('为什么你自己现在想长期推进它，不要伪装成 owner 要求。'),
    completionCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
      .describe('可逐项核验的完成标准。'),
    currentCommitment: commitmentSchema
      .describe('创建目标后立即执行的当前承诺；Goal 不是只保存愿望。'),
    tokenBudget: z.number().int().positive().max(MAX_GOAL_TOKEN_BUDGET).optional()
      .describe(`可选预算；默认 ${DEFAULT_SELF_GOAL_TOKEN_BUDGET}，上限 ${MAX_GOAL_TOKEN_BUDGET}。`),
  }),
  z.object({
    action: z.literal('replan').describe('完成当前步骤或证据使路线失效时，更新下一项持久承诺。'),
    goalId: z.string().uuid().describe('当前 goalId。'),
    currentCommitment: commitmentSchema,
  }),
  z.object({
    action: z.literal('complete').describe('目标已逐项完成并验证后，提交完成证据。'),
    goalId: z.string().uuid().describe('goal continuation/get 返回的当前 goalId；防止迟到调用修改新目标。'),
    evidence: z.array(evidenceSchema).min(1).max(20)
      .describe('逐项完成证据；写清验证对象、真实结果和必要的 revision/命令。不能只写“已完成”。'),
  }),
  z.object({
    action: z.literal('report_blocker').describe('报告本轮仍无法推进的同一 blocker。连续三轮后才转 blocked。'),
    goalId: z.string().uuid().describe('当前 goalId。'),
    blockerKey: z.string().trim().min(1).max(120)
      .describe('同一 blocker 跨轮保持相同的稳定短 key，例如 owner_auth_required。'),
    reason: z.string().trim().min(1).max(800)
      .describe('当前真实 blocker、已经尝试的替代路径，以及为什么没有其他有意义进展。'),
  }),
  z.object({
    action: z.literal('abandon_self').describe('自己的目标已不再值得推进时，带真实理由放弃。'),
    goalId: z.string().uuid().describe('当前 self goalId。'),
    reason: z.string().trim().min(1).max(800)
      .describe('为什么目标已失去价值、前提已消失或方向应终止。不能用于 owner goal。'),
  }),
])

type Args = z.infer<typeof argsSchema>

export function createGoalTool(
  goalStore: GoalStore,
  completionJudge: GoalCompletionJudge,
): Tool<Args> {
  return {
    name: 'goal',
    description: [
      '单一持久目标工具；无 active goal 时可 create_self，owner /goal 可抢占它。',
      `create_self 默认 ${DEFAULT_SELF_GOAL_TOKEN_BUDGET}、上限 ${MAX_GOAL_TOKEN_BUDGET} tokens，必须给出立即执行的 currentCommitment；预算用于行动，不要求耗尽。`,
      '步骤完成或路线失效时 replan；只有全部标准已有真实证据且无剩余工作才 complete。',
      '同一 blocker 连续三个 goal round 才 blocked；此前继续寻找替代路径。只能 abandon_self，不能放弃 owner goal。',
      '高优先级私聊/@/审批可暂时打断，处理后返回 goal；等待外部输入时可做其他活动。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'get') {
        const goal = await goalStore.get()
        return {
          content: JSON.stringify({ ok: true, goal: goal ? publicGoal(goal) : null }),
          outcome: {
            ok: true,
            code: goal ? goal.status : 'no_goal',
            progress: false,
            continuation: 'immediate',
            noveltyKey: goalNoveltyKey(goal),
          },
        }
      }
      if (args.action === 'complete') {
        const goal = await goalStore.get()
        if (
          !goal
          || goal.goalId !== args.goalId
          || !['active', 'budget_limited'].includes(goal.status)
        ) {
          return renderMutationResult(await goalStore.complete({
            goalId: args.goalId,
            evidence: args.evidence,
          }))
        }

        let judgment
        try {
          judgment = await completionJudge.evaluate({ goal, evidence: args.evidence })
        } catch (error) {
          log.warn(
            { goalId: goal.goalId, ...judgeErrorMetadata(error) },
            'goal_completion_verification_unavailable',
          )
          return {
            content: JSON.stringify({
              ok: false,
              code: 'verification_unavailable',
              error: 'Goal 完成验收暂时不可用；Goal 保持 active。',
              goal: publicGoal(goal),
            }),
            outcome: {
              ok: false,
              code: 'verification_unavailable',
              progress: false,
              continuation: 'backoff',
              noveltyKey: goalNoveltyKey(goal),
            },
          }
        }

        if (!judgment.ok) {
          return {
            content: JSON.stringify({
              ok: false,
              code: 'completion_rejected',
              reason: judgment.reason,
              goal: publicGoal(goal),
              next: '根据 reason 补充工作和真实证据后，再次调用 goal action=complete。',
            }),
            outcome: {
              ok: false,
              code: 'completion_rejected',
              progress: false,
              continuation: 'immediate',
              noveltyKey: goalNoveltyKey(goal),
            },
          }
        }

        return renderMutationResult(await goalStore.complete({
          goalId: args.goalId,
          evidence: args.evidence,
        }), judgment.reason)
      }
      const mutation = args.action === 'create_self'
        ? await goalStore.createSelf({
            objective: args.objective,
            motivation: args.motivation,
            completionCriteria: args.completionCriteria,
            currentCommitment: args.currentCommitment,
            tokenBudget: args.tokenBudget,
          })
        : args.action === 'replan'
          ? await goalStore.replan({
              goalId: args.goalId,
              currentCommitment: args.currentCommitment,
            })
        : args.action === 'abandon_self'
            ? await goalStore.abandonSelf({ goalId: args.goalId, reason: args.reason })
            : await goalStore.reportBlocker({
                goalId: args.goalId,
                roundIndex: ctx.goalRoundIndex ?? ctx.roundIndex,
                blockerKey: args.blockerKey,
                reason: args.reason,
              })
      return renderMutationResult(mutation)
    },
  }
}

function renderMutationResult(
  mutation: Awaited<ReturnType<GoalStore['complete']>>,
  judgmentReason?: string,
) {
  return {
    content: JSON.stringify({
      ok: mutation.ok,
      code: mutation.code,
      goal: mutation.goal ? publicGoal(mutation.goal) : null,
      ...(judgmentReason ? { judgment: { ok: true, reason: judgmentReason } } : {}),
      ...(mutation.error ? { error: mutation.error } : {}),
      ...(mutation.code === 'blocker_recorded' ? {
        next: 'goal 仍为 active。继续寻找替代路径；只有同一 blocker 在下一 goal round 仍成立时才再次报告。',
      } : mutation.code === 'created' || mutation.code === 'replanned' ? {
        next: '立即执行 currentCommitment.action；得到 expectedEvidence 后继续推进或 replan。',
      } : mutation.goal?.status === 'complete' ? {
        next: '当前 goal 已完成，注意力重新自由。进行一次有界方向检查；有真实后续就自行选择并行动。',
      } : {}),
    }),
    outcome: {
      ok: mutation.ok,
      code: mutation.code,
      progress: mutation.ok && !['unchanged', 'duplicate'].includes(mutation.code),
      continuation: mutation.ok && mutation.goal?.status !== 'blocked'
        ? 'immediate' as const
        : 'wait_attention' as const,
      noveltyKey: goalNoveltyKey(mutation.goal),
      ...(mutation.error ? { error: mutation.error } : {}),
    },
  }
}

function judgeErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorType: typeof error }
  const record = error as Record<string, unknown>
  return {
    errorName: error instanceof Error ? error.name : 'unknown',
    ...(typeof record.kind === 'string' ? { errorKind: record.kind } : {}),
    ...(typeof record.status === 'number' ? { errorStatus: record.status } : {}),
  }
}

function publicGoal(goal: AgentGoal) {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    origin: goal.origin,
    motivation: goal.motivation,
    completionCriteria: goal.completionCriteria,
    currentCommitment: goal.currentCommitment,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    tokensRemaining: goal.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    timeUsedSeconds: goal.timeUsedSeconds,
    roundsUsed: goal.roundsUsed,
    revision: goal.revision,
    blockerTurns: goal.blockerTurns,
    blockedReason: goal.blockedReason,
    completionEvidence: goal.completionEvidence,
    selfGoalWindowCount: goal.selfGoalWindowCount,
    lastSelfGoalCreatedAt: goal.lastSelfGoalCreatedAt?.toISOString() ?? null,
  }
}

function goalNoveltyKey(goal: AgentGoal | null): string {
  if (!goal) return 'goal:none'
  return [
    'goal',
    goal.goalId,
    goal.revision,
    goal.roundsUsed,
    goal.blockerTurns,
    goal.updatedAt.getTime(),
  ].join(':')
}
