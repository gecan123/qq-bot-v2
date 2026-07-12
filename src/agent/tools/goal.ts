import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  DEFAULT_SELF_GOAL_TOKEN_BUDGET,
  MAX_GOAL_TOKEN_BUDGET,
  type AgentGoal,
  type GoalStore,
} from '../goal-store.js'

const evidenceSchema = z.string().trim().min(1).max(500)

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
    tokenBudget: z.number().int().positive().max(MAX_GOAL_TOKEN_BUDGET).optional()
      .describe(`可选预算；默认 ${DEFAULT_SELF_GOAL_TOKEN_BUDGET}，上限 ${MAX_GOAL_TOKEN_BUDGET}。`),
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

export function createGoalTool(goalStore: GoalStore): Tool<Args> {
  return {
    name: 'goal',
    description: [
      '单一持久目标工具。你可以在没有未完成 goal 时用 create_self 给自己建立长期主线；owner 私聊 /goal 始终优先并可抢占 self goal。',
      'action=get: 读取当前 goal。',
      `action=create_self: 自主创建 self goal，默认 ${DEFAULT_SELF_GOAL_TOKEN_BUDGET} tokens、上限 ${MAX_GOAL_TOKEN_BUDGET}；runtime 另有宽松的 60 秒/64 次每 24 小时保险丝。`,
      'action=complete: 只有 objective 的全部要求都被当前真实证据证明、没有剩余工作时才调用。',
      'action=report_blocker: 同一 blocker 连续三个 goal round 都成立时才会把状态转成 blocked；前两次保持 active 并要求继续寻找可行路径。',
      'action=abandon_self: 只允许放弃自己创建的 goal；不能放弃 owner goal。',
      'priority=high 私聊/@/审批可以临时打断 active goal，但处理完要回到 goal；等待后台、外部输入或冷却时可做其他活动。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'get') {
        const goal = await goalStore.get()
        return {
          content: JSON.stringify({ ok: true, goal: goal ? publicGoal(goal) : null }),
          outcome: { ok: true, code: goal ? goal.status : 'no_goal' },
        }
      }
      const mutation = args.action === 'create_self'
        ? await goalStore.createSelf({
            objective: args.objective,
            motivation: args.motivation,
            completionCriteria: args.completionCriteria,
            tokenBudget: args.tokenBudget,
          })
        : args.action === 'complete'
          ? await goalStore.complete({ goalId: args.goalId, evidence: args.evidence })
          : args.action === 'abandon_self'
            ? await goalStore.abandonSelf({ goalId: args.goalId, reason: args.reason })
            : await goalStore.reportBlocker({
                goalId: args.goalId,
                roundIndex: ctx.goalRoundIndex ?? ctx.roundIndex,
                blockerKey: args.blockerKey,
                reason: args.reason,
              })
      return {
        content: JSON.stringify({
          ok: mutation.ok,
          code: mutation.code,
          goal: mutation.goal ? publicGoal(mutation.goal) : null,
          ...(mutation.error ? { error: mutation.error } : {}),
          ...(mutation.code === 'blocker_recorded' ? {
            next: 'goal 仍为 active。继续寻找替代路径；只有同一 blocker 在下一 goal round 仍成立时才再次报告。',
          } : {}),
        }),
        outcome: {
          ok: mutation.ok,
          code: mutation.code,
          ...(mutation.error ? { error: mutation.error } : {}),
        },
      }
    },
  }
}

function publicGoal(goal: AgentGoal) {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    origin: goal.origin,
    motivation: goal.motivation,
    completionCriteria: goal.completionCriteria,
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
