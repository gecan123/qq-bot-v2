import {
  createOrReuseActionIntent,
  createOrReuseDecision,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  getOrCreateMainAgentRuntime,
  getOrCreateScene,
  markOpportunityStatus,
} from './agent-runtime-store.js'
import {
  buildBarrierOutput,
  decideExecution,
  DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
  verdictFromEffectMode,
} from './action-barrier.js'
import { makeQqGroupSceneId, type ActionDeliveryState } from './agent-runtime-types.js'
import type { ExecutableActionIntent } from './action-executor.js'
import type { Prisma } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'

const log = createLogger('PROACTIVE_DISPATCH')

export interface ProactiveSendActionExecutor {
  execute(intent: ExecutableActionIntent): Promise<{
    deliveryResult: ActionDeliveryState
    actionRecord: { id: string; deliveryState: ActionDeliveryState }
  }>
}

export interface DispatchProactiveSendInput {
  groupId: number
  text: string
  /** 触发本次主动发言的 wakeup 时间戳。 */
  wakeupAt: Date
  /** proactive-session 的 sessionId（也用作 chain idempotency 前缀）。 */
  proactiveSessionId: string
}

export interface DispatchProactiveSendResult {
  deliveryResult: ActionDeliveryState
  effectMode: string
  reason: string
  actionRecordId: string
}

/**
 * 把 proactive_send 接进 Runtime 标准链:
 * RuntimeEvent → Opportunity → Decision → ActionIntent → Executor → ActionRecord。
 *
 * Phase 0 还债——之前 proactive-session 直调 sendGroupReply 绕开这一切。
 *
 * Barrier 默认对 send_group_message 压成 dry_run/suppressed (Phase 10 之前不开 live)。
 */
export async function dispatchProactiveSend(
  input: DispatchProactiveSendInput,
  options: { actionExecutor: ProactiveSendActionExecutor },
): Promise<DispatchProactiveSendResult> {
  const sceneId = makeQqGroupSceneId(input.groupId)
  const sendIdempotencyKey = `${input.proactiveSessionId}:send:${hashText(input.text)}`

  // 1. Scene + agent runtime 占位
  await getOrCreateMainAgentRuntime()
  await getOrCreateScene({
    kind: 'qq_group',
    externalId: String(input.groupId),
  })

  // 2. RuntimeEvent (复用 scheduler_tick,代表 wakeup)
  const runtimeEvent = await createOrReuseRuntimeEvent({
    sceneId,
    eventType: 'scheduler_tick',
    payload: {
      proactiveSessionId: input.proactiveSessionId,
      wakeupAt: input.wakeupAt.toISOString(),
      groupId: input.groupId,
    } as Prisma.JsonObject,
    occurredAt: input.wakeupAt,
    idempotencyKey: `${input.proactiveSessionId}:tick`,
  })

  // 3. Opportunity (queueKind=social, type=speak_proactively)
  const opportunity = await createOrReuseOpportunity({
    sceneId,
    runtimeEventId: runtimeEvent.id,
    queueKind: 'social',
    opportunityType: 'speak_proactively',
    priority: 0,
    payload: {
      proactiveSessionId: input.proactiveSessionId,
    } as Prisma.JsonObject,
    idempotencyKey: `${input.proactiveSessionId}:opp`,
  })

  // 4. Barrier verdict (deterministic,Executor 内部还会重算一次,这里只是为了写 Decision)
  const barrierVerdict = decideExecution(
    { actionType: 'send_group_message', targetSceneId: sceneId },
    {},
    DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
  )
  const barrierOutput = buildBarrierOutput(barrierVerdict)

  // 5. Decision
  const decision = await createOrReuseDecision({
    opportunityId: opportunity.id,
    idempotencyKey: `${sendIdempotencyKey}:policy`,
    policyVersion: barrierVerdict.policyVersion,
    verdict: verdictFromEffectMode(barrierVerdict.effectMode),
    actionType: 'send_group_message',
    riskLevel: barrierVerdict.riskBand,
    reason: barrierVerdict.reason,
    barrierInput: {
      actionType: 'send_group_message',
      targetSceneId: sceneId,
      riskBand: barrierVerdict.riskBand,
    } as Prisma.JsonObject,
    barrierOutput: barrierOutput as Prisma.JsonObject,
  })

  // 6. ActionIntent
  const intentRow = await createOrReuseActionIntent({
    opportunityId: opportunity.id,
    decisionId: decision.id,
    actionType: 'send_group_message',
    targetSceneId: sceneId,
    payload: {
      target: { groupId: input.groupId },
      text: input.text,
      proposedEffect: { type: 'send_group_message', text: input.text },
    } as Prisma.JsonObject,
    dryRun: barrierVerdict.effectMode === 'dry_run',
    riskLevel: barrierVerdict.riskBand,
    status: 'approved',
    idempotencyKey: sendIdempotencyKey,
  })

  // 7. ExecutableActionIntent
  const intent: ExecutableActionIntent = {
    id: intentRow.id,
    opportunityId: intentRow.opportunityId,
    decisionId: intentRow.decisionId,
    actionType: intentRow.actionType,
    targetSceneId: intentRow.targetSceneId,
    payload: intentRow.payload as Record<string, unknown>,
    dryRun: intentRow.dryRun,
    riskLevel: intentRow.riskLevel,
    status: intentRow.status,
    idempotencyKey: intentRow.idempotencyKey,
  }

  // 8. Execute
  const result = await options.actionExecutor.execute(intent)

  // 9. 立即 mark Opportunity 终态——避免 root-runtime 的 drainArbiterQueue
  // 把这个 pending speak_proactively opp 当成"待执行"扫到, 然后误判 skipped。
  await markOpportunityStatus(opportunity.id, opportunityStatusFromDelivery(result.deliveryResult))

  log.info(
    {
      direction: 'internal',
      actor: 'bot',
      category: 'ambient_post',
      flow: 'proactive_send_dispatch',
      groupId: input.groupId,
      sceneId,
      proactiveSessionId: input.proactiveSessionId,
      effectMode: barrierVerdict.effectMode,
      deliveryResult: result.deliveryResult,
      actionRecordId: result.actionRecord.id,
      opportunityId: opportunity.id,
    },
    'proactive_send_dispatched',
  )

  return {
    deliveryResult: result.deliveryResult,
    effectMode: barrierVerdict.effectMode,
    reason: barrierVerdict.reason,
    actionRecordId: result.actionRecord.id,
  }
}

function opportunityStatusFromDelivery(state: ActionDeliveryState): string {
  switch (state) {
    case 'sent':
    case 'acked':
    case 'dry_run':
      return 'succeeded'
    case 'suppressed':
    case 'skipped':
      return 'skipped'
    case 'failed':
      return 'failed'
    default:
      return 'skipped'
  }
}

/**
 * 简单的内容哈希,用作 send idempotency key 后缀。
 * 同一 session 内同样文本被重复请求 → 同一个 ActionRecord (天然去重)。
 * 同一 session 内不同文本 → 不同 ActionRecord。
 */
function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(16).slice(0, 12)
}
