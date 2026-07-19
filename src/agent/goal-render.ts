import type { AgentGoal } from './goal-store.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export function renderGoalStateEvent(goal: AgentGoal): string {
  return JSON.stringify({
    event: 'goal_state_changed',
    goal: publicGoalState(goal),
    instruction: goalStateInstruction(goal),
  })
}

export function renderGoalContinuation(
  goal: AgentGoal,
  reason: 'automatic_continuation' | 'post_compaction' = 'automatic_continuation',
): string {
  return JSON.stringify({
    event: 'goal_continuation',
    reason,
    goal: publicGoalState(goal),
    scheduling: {
      foreground: 'single_turn_only',
      attention: '先处理本轮已经披露的 priority=high 私聊/@/审批；处理后回到 goal。',
      background: '可使用现有 background_task/delegate 并发独立工作；不要创建第二个主循环。',
      unrelatedWork: 'goal 有立即可执行步骤时不要主动开启无关自由活动；等待后台、外部输入或冷却时才可利用空档。',
    },
    completion: {
      instruction: goal.currentCommitment
        ? '先执行 currentCommitment.action 并取得 expectedEvidence；步骤完成或路线失效时调用 goal action=replan。逐项核对 objective 与当前真实状态，全部完成且有证据时才 action=complete。'
        : '当前还没有 currentCommitment；先调用 goal action=replan 自主选择一个具体、可立即开始且有 expectedEvidence 的步骤，再推进 objective。',
      blocked: '每个仍被同一 blocker 卡住的 goal round 都用相同 blockerKey 调 goal action=report_blocker；前两次保持 active，连续第三次才转 blocked。',
    },
  })
}

function publicGoalState(goal: AgentGoal) {
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
    tokensRemaining: goal.tokenBudget == null
      ? null
      : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    timeUsedSeconds: goal.timeUsedSeconds,
    roundsUsed: goal.roundsUsed,
    revision: goal.revision,
    blockerTurns: goal.blockerTurns,
    blockedReason: goal.blockedReason,
    completionEvidence: goal.completionEvidence,
    selfGoalWindowCount: goal.selfGoalWindowCount,
    lastSelfGoalCreatedAt: goal.lastSelfGoalCreatedAt
      ? formatBeijingIso(goal.lastSelfGoalCreatedAt)
      : null,
    createdAt: formatBeijingIso(goal.createdAt),
    updatedAt: formatBeijingIso(goal.updatedAt),
  }
}

function goalStateInstruction(goal: AgentGoal): string {
  switch (goal.status) {
    case 'active':
      return `${goal.origin === 'self' ? 'self goal' : 'owner goal'} 已激活。它是默认工作主线，但 priority=high 注意事件可以临时打断；处理后继续目标。`
    case 'paused':
      return 'goal 已被 owner 暂停。不要继续实质推进，等待 owner resume。'
    case 'blocked':
      return goal.origin === 'self'
        ? 'self goal 已确认阻塞。不要空转重试；可以等待外部状态变化，或确认不再值得推进后 action=abandon_self。'
        : 'owner goal 已确认阻塞。不要空转重试；说明 blocker，等待 owner 或外部状态变化后 resume。'
    case 'budget_limited':
      return goal.origin === 'self'
        ? 'self goal 已达到 token budget。停止新的实质工作；可以保留结果并 action=abandon_self，或等待 owner 调整预算。'
        : 'owner goal 已达到 token budget。停止新的实质工作，只做有界收尾并向 owner说明进度和剩余事项。'
    case 'usage_limited':
      return goal.origin === 'self'
        ? 'self goal 因 provider usage limit 停止。不要自动重试；等待额度恢复或 action=abandon_self。'
        : 'owner goal 因 provider usage limit 停止。不要自动重试，等待 owner resume。'
    case 'complete':
      return 'goal 已完成。不要继续 goal continuation；注意力已经重新自由，进行一次有界方向检查，有真实后续就自行选择并行动。'
    case 'cancelled':
      return 'goal 已被 owner 取消。停止相关续轮；迟到后台结果不得自动产生新副作用。'
    case 'abandoned':
      return 'self goal 已由 Agent 主动放弃。停止相关续轮；迟到后台结果不得自动产生新副作用。'
  }
}
