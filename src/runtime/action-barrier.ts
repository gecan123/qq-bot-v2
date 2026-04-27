import type { Prisma } from '../generated/prisma/client.js'
import type { ActionType, DecisionVerdict, RiskLevel } from './agent-runtime-types.js'

export type EffectMode = 'live' | 'dry_run' | 'suppressed' | 'requires_review' | 'blocked'

export const ACTION_BARRIER_POLICY_VERSION = 'runtime-os.phase8.minimal-barrier.v1'

export interface ActionBarrierAction {
  actionType: ActionType | 'internal' | 'public_post'
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
  allowAmbientGroupPostLive?: boolean
  allowPublicPostLive?: boolean
  privateReplyDryRun?: boolean
  anchoredGroupReplyDryRun?: boolean
  ambientGroupPostDryRun?: boolean
}

export const DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG = {
  allowPrivateReplyLive: true,
  allowAnchoredGroupReplyLive: true,
  allowAmbientGroupPostLive: false,
  ambientGroupPostDryRun: true,
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
      return 'anchored_group_reply'
    case 'send_group_message':
      return 'ambient_group_post'
    case 'public_post':
      return 'public_post'
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

  if (riskBand === 'public_post') {
    const liveAllowed = runtimeConfig.allowPublicPostLive === true
    return {
      riskBand,
      allowedByPolicy: liveAllowed,
      effectMode: liveAllowed && executorAvailable && !dryRunRequested ? 'live' : 'blocked',
      reason: liveAllowed ? 'public post live execution is allowed by policy' : 'public post is blocked by default',
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

  if (riskBand === 'anchored_group_reply') {
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

  const ambientLiveAllowed = runtimeConfig.allowAmbientGroupPostLive === true
  const ambientDryRun = runtimeConfig.ambientGroupPostDryRun ?? true
  return {
    riskBand,
    allowedByPolicy: ambientLiveAllowed && !dryRunRequested,
    effectMode: ambientLiveAllowed && !dryRunRequested ? 'live' : ambientDryRun ? 'dry_run' : 'blocked',
    reason: ambientLiveAllowed && !dryRunRequested
      ? 'ambient group post live execution is allowed by policy'
      : ambientDryRun
        ? 'ambient group post is dry-run before proactive live-send canary'
        : 'ambient group post is blocked by policy',
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
