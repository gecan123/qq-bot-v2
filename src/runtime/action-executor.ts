import type { MessageSender } from '../messaging/message-sender.js'
import { createOrReuseActionRecord } from './agent-runtime-store.js'
import type { ActionRecord, ActionDeliveryState, ActionType, SceneId } from './agent-runtime-types.js'
import {
  type EffectMode,
  buildBarrierOutput,
  DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
  decideExecution,
  deliveryStateFromEffectMode,
} from './action-barrier.js'
import type { Prisma } from '../generated/prisma/client.js'

export interface ActionExecutorOptions {
  sender?: MessageSender
  actionStore?: {
    createOrReuseActionRecord: typeof createOrReuseActionRecord
    markDeliveryState?: (id: string, state: ActionDeliveryState, result?: Record<string, unknown>) => Promise<void>
  }
}

export interface ExecutableActionIntent {
  id: string
  opportunityId: string
  decisionId?: string | null
  actionType: string
  targetSceneId: string
  payload: Record<string, unknown>
  dryRun: boolean
  riskLevel?: string
  status?: string
  idempotencyKey: string
}

export interface ActionExecutorResult {
  intent: ExecutableActionIntent
  actionRecord: ActionRecord
  deliveryResult: ActionDeliveryState
}

function getNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function getNestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getText(payload: Record<string, unknown>): string {
  const proposedEffect = getNestedRecord(payload, 'proposedEffect')
  const value = proposedEffect?.text ?? payload.text
  return typeof value === 'string' ? value : ''
}

function getGroupId(payload: Record<string, unknown>): number | null {
  return getNumber(getNestedRecord(payload, 'target') ?? {}, 'groupId') ?? getNumber(payload, 'groupId')
}

function getUserId(payload: Record<string, unknown>): number | null {
  return getNumber(getNestedRecord(payload, 'target') ?? {}, 'userId') ?? getNumber(payload, 'userId')
}

function getReplyToMessageId(payload: Record<string, unknown>): number | null {
  const deliveryPayload = getNestedRecord(payload, 'deliveryPayload')
  return getNumber(deliveryPayload ?? {}, 'replyToMessageId') ?? getNumber(deliveryPayload ?? {}, 'messageId') ?? getNumber(payload, 'messageId')
}

function isReplyAction(actionType: string): boolean {
  return actionType === 'reply_to_message' || actionType === 'send_group_reply'
}

interface StoredBarrierVerdict {
  effectMode: EffectMode
  reason: string
  barrierOutput: Record<string, unknown>
}

function readBarrierVerdict(intent: ExecutableActionIntent, executorAvailable: boolean): StoredBarrierVerdict {
  const stored = getNestedRecord(intent.payload, 'barrierVerdict')
  if (stored && typeof stored.effectMode === 'string') {
    return {
      effectMode: stored.effectMode as EffectMode,
      reason: typeof stored.reason === 'string' ? stored.reason : 'stored barrier verdict',
      barrierOutput: stored,
    }
  }
  // fallback for legacy intents without barrierVerdict: re-evaluate barrier policy
  const verdict = decideExecution(
    { actionType: intent.actionType, targetSceneId: intent.targetSceneId, dryRunRequested: intent.dryRun, executorAvailable },
    {},
    DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
  )
  return {
    effectMode: verdict.effectMode,
    reason: verdict.reason,
    barrierOutput: buildBarrierOutput(verdict) as Record<string, unknown>,
  }
}

export function createActionExecutor(options: ActionExecutorOptions = {}) {
  const store = options.actionStore ?? { createOrReuseActionRecord }

  return {
    async execute(intent: ExecutableActionIntent): Promise<ActionExecutorResult> {
      const verdict = readBarrierVerdict(intent, Boolean(options.sender))
      const initialState: ActionDeliveryState = intent.actionType === 'artifact_only'
        ? 'dry_run'
        : deliveryStateFromEffectMode(verdict.effectMode)
      const actionRecord = await store.createOrReuseActionRecord({
        actionIntentId: intent.id,
        actionType: intent.actionType as ActionType,
        targetSceneId: intent.targetSceneId as SceneId,
        deliveryState: initialState,
        idempotencyKey: intent.idempotencyKey,
        resultPayload: (initialState === 'dry_run'
          ? { reason: 'action intent is dry-run or artifact-only', barrierVerdict: verdict.barrierOutput }
          : { barrierVerdict: verdict.barrierOutput }) as Prisma.JsonObject,
      })

      if (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked' || actionRecord.deliveryState === 'dry_run') {
        return { intent, actionRecord, deliveryResult: actionRecord.deliveryState }
      }

      if (verdict.effectMode !== 'live') {
        await store.markDeliveryState?.(actionRecord.id, 'skipped', { reason: verdict.reason, barrierVerdict: verdict.barrierOutput })
        return { intent, actionRecord, deliveryResult: 'skipped' }
      }

      if (!options.sender) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { reason: 'missing sender', barrierVerdict: verdict.barrierOutput })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      const text = getText(intent.payload)
      const groupId = getGroupId(intent.payload)
      const userId = getUserId(intent.payload)
      if (!text || (intent.actionType === 'send_private_message' ? userId == null : groupId == null)) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { reason: 'invalid payload', barrierVerdict: verdict.barrierOutput })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      await store.markDeliveryState?.(actionRecord.id, 'sending')
      const messageId = isReplyAction(intent.actionType) ? getReplyToMessageId(intent.payload) : null
      const sendResult = intent.actionType === 'send_private_message'
        ? options.sender.sendPrivateMessage
          ? await options.sender.sendPrivateMessage({ userId: userId ?? 0, text })
          : { success: false, attempts: 0 }
        : messageId != null
          ? await options.sender.replyToMessage({ groupId: groupId ?? 0, replyToMessageId: messageId, text })
          : await options.sender.sendMessage({ groupId: groupId ?? 0, text })

      if (!sendResult.success) {
        await store.markDeliveryState?.(actionRecord.id, 'failed', { error: 'send failed', barrierVerdict: verdict.barrierOutput })
        return { intent, actionRecord, deliveryResult: 'failed' }
      }

      const deliveryResult: ActionDeliveryState = sendResult.providerMessageId == null ? 'sent' : 'acked'
      await store.markDeliveryState?.(actionRecord.id, deliveryResult, {
        providerMessageId: sendResult.providerMessageId ?? null,
        barrierVerdict: verdict.barrierOutput,
      })
      return { intent, actionRecord, deliveryResult }
    },
  }
}
