import type { Prisma } from '../generated/prisma/client.js'
import type { ActionType, DecisionVerdict, RiskLevel } from './agent-runtime-types.js'

export type EffectMode = 'live' | 'dry_run' | 'suppressed' | 'requires_review' | 'blocked'

export const ACTION_BARRIER_POLICY_VERSION = 'runtime-os.phase8.minimal-barrier.v1'

export interface ActionBarrierAction {
  actionType: ActionType | 'internal'
  sourceKind?: string
  deliveryMode?: string
  targetSceneId?: string
  dryRunRequested?: boolean
  executorAvailable?: boolean
}

export interface ActionBarrierRuntimeConfig {
  allowInternal?: boolean
  allowPersistence?: boolean
  allowPrivateReplyLive?: boolean
  allowAnchoredGroupReplyLive?: boolean
  /**
   * 主动群发（无 anchor message 的 send_group_message）默认 false——Phase 10 之前
   * barrier 永远把它压成 dry_run/suppressed，防止 LLM 直接驱动外部副作用。
   */
  allowSendGroupMessageLive?: boolean
  privateReplyDryRun?: boolean
  anchoredGroupReplyDryRun?: boolean
  sendGroupMessageDryRun?: boolean
}

export const DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG = {
  allowPrivateReplyLive: true,
  allowAnchoredGroupReplyLive: true,
  allowSendGroupMessageLive: false,
} satisfies ActionBarrierRuntimeConfig

export interface ActionBarrierVerdict {
  riskBand: RiskLevel
  allowedByPolicy: boolean
  effectMode: EffectMode
  reason: string
  policyVersion: string
}

export function classifyAction(action: ActionBarrierAction): RiskLevel {
  switch (action.actionType) {
    case 'internal':
      return 'internal'
    case 'artifact_only':
    case 'read_forum_post':
    case 'read_news_item':
    case 'create_memory_proposal':
    case 'update_self_spine':
      return 'persistence'
    case 'send_private_message':
      return 'private_reply'
    case 'reply_to_message':
    case 'send_group_reply':
    case 'send_group_message':
      return 'anchored_group_reply'
  }
}

export function decideExecution(
  action: ActionBarrierAction,
  _scenePolicy: Record<string, unknown> = {},
  runtimeConfig: ActionBarrierRuntimeConfig = {},
): ActionBarrierVerdict {
  const riskBand = classifyAction(action)
  const executorAvailable = action.executorAvailable ?? true
  const dryRunRequested = action.dryRunRequested === true

  if (riskBand === 'internal') {
    const allowed = runtimeConfig.allowInternal ?? true
    return {
      riskBand,
      allowedByPolicy: allowed,
      effectMode: allowed ? 'live' : 'blocked',
      reason: allowed ? 'internal runtime action is allowed' : 'internal runtime action blocked by policy',
      policyVersion: ACTION_BARRIER_POLICY_VERSION,
    }
  }

  if (riskBand === 'persistence') {
    if (action.actionType === 'update_self_spine') {
      return {
        riskBand,
        allowedByPolicy: false,
        effectMode: 'requires_review',
        reason: 'self spine mutation must go through proposal review before versioned write',
        policyVersion: ACTION_BARRIER_POLICY_VERSION,
      }
    }

    const allowed = runtimeConfig.allowPersistence ?? true
    return {
      riskBand,
      allowedByPolicy: allowed,
      effectMode: allowed ? 'live' : 'blocked',
      reason: allowed ? 'local persistence action is allowed with audit' : 'local persistence action blocked by policy',
      policyVersion: ACTION_BARRIER_POLICY_VERSION,
    }
  }

  if (!executorAvailable) {
    return {
      riskBand,
      allowedByPolicy: false,
      effectMode: 'suppressed',
      reason: 'external action executor is unavailable',
      policyVersion: ACTION_BARRIER_POLICY_VERSION,
    }
  }

  if (riskBand === 'private_reply') {
    const liveAllowed = runtimeConfig.allowPrivateReplyLive ?? true
    const dryRun = dryRunRequested || runtimeConfig.privateReplyDryRun === true
    return {
      riskBand,
      allowedByPolicy: liveAllowed && !dryRun,
      effectMode: liveAllowed ? dryRun ? 'dry_run' : 'live' : 'suppressed',
      reason: liveAllowed
        ? dryRun ? 'private reply live execution is disabled by dry-run config' : 'private reply live execution is allowed'
        : 'private reply live execution is disabled by policy',
      policyVersion: ACTION_BARRIER_POLICY_VERSION,
    }
  }

  // riskBand === 'anchored_group_reply'
  // 这里要按 actionType 进一步分流: send_group_message (无 anchor 的主动外发) 比
  // anchored reply 风险更高,Phase 10 之前默认压成 suppressed/dry_run。
  if (action.actionType === 'send_group_message') {
    const liveAllowed = runtimeConfig.allowSendGroupMessageLive ?? false
    const dryRun = dryRunRequested || runtimeConfig.sendGroupMessageDryRun === true
    return {
      riskBand,
      allowedByPolicy: liveAllowed && !dryRun,
      effectMode: liveAllowed ? dryRun ? 'dry_run' : 'live' : 'suppressed',
      reason: liveAllowed
        ? dryRun ? 'ambient group post live execution is disabled by dry-run config' : 'ambient group post live execution is explicitly allowed'
        : 'ambient group post live execution is disabled by policy (Phase 10 gate)',
      policyVersion: ACTION_BARRIER_POLICY_VERSION,
    }
  }

  const liveAllowed = runtimeConfig.allowAnchoredGroupReplyLive ?? true
  const dryRun = dryRunRequested || runtimeConfig.anchoredGroupReplyDryRun === true
  return {
    riskBand,
    allowedByPolicy: liveAllowed && !dryRun,
    effectMode: liveAllowed ? dryRun ? 'dry_run' : 'live' : 'suppressed',
    reason: liveAllowed
      ? dryRun ? 'anchored group reply live execution is disabled by dry-run config' : 'anchored group reply live execution is allowed'
      : 'anchored group reply live execution is disabled by policy',
    policyVersion: ACTION_BARRIER_POLICY_VERSION,
  }
}

export function verdictFromEffectMode(effectMode: EffectMode): DecisionVerdict {
  switch (effectMode) {
    case 'live':
      return 'approved'
    case 'dry_run':
      return 'dry_run'
    case 'suppressed':
      return 'skipped'
    case 'requires_review':
      return 'requires_review'
    case 'blocked':
      return 'blocked'
  }
}

export function deliveryStateFromEffectMode(effectMode: EffectMode): 'pending' | 'dry_run' | 'suppressed' | 'skipped' {
  switch (effectMode) {
    case 'live':
      return 'pending'
    case 'dry_run':
      return 'dry_run'
    case 'suppressed':
      return 'suppressed'
    case 'requires_review':
    case 'blocked':
      return 'skipped'
  }
}

export function buildBarrierOutput(verdict: ActionBarrierVerdict): Prisma.JsonObject {
  return {
    riskBand: verdict.riskBand,
    allowedByPolicy: verdict.allowedByPolicy,
    effectMode: verdict.effectMode,
    reason: verdict.reason,
    policyVersion: verdict.policyVersion,
  }
}
