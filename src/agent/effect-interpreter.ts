import type { ReactToolEffect } from './react-kernel.js'
import type { InboxReadEffect, MessageSentTarget } from './tool.js'
import { createLogger } from '../logger.js'
import { conversationKey } from '../chat/conversation.js'

const log = createLogger('EFFECT_INTERPRETER')

export interface EffectInterpretation {
  sentTargets: MessageSentTarget[]
  inboxReads?: InboxReadEffect[]
  workContinuationRequested?: true
}

export function interpretToolEffects(effects: ReactToolEffect[]): EffectInterpretation {
  const sentTargets: MessageSentTarget[] = []
  const seenSentTargets = new Set<string>()
  const inboxReads = new Map<string, InboxReadEffect>()
  let workContinuationRequested = false

  for (const item of effects) {
    switch (item.effect.type) {
      case 'message_sent': {
        if (item.toolName !== 'send_message') {
          logRejectedEffect(item, 'untrusted_tool')
          break
        }
        const target = parseMessageSentTarget(item.effect.target)
        if (!target) {
          logRejectedEffect(item, 'invalid_target')
          break
        }
        if (item.effect.continueWork === true) workContinuationRequested = true
        const key = conversationKey(target)
        if (seenSentTargets.has(key)) break
        seenSentTargets.add(key)
        sentTargets.push(target)
        break
      }
      case 'inbox_read': {
        if (item.toolName !== 'inbox') {
          logRejectedEffect(item, 'untrusted_tool')
          break
        }
        if (
          !/^(?:(?:qq|feishu):[^:]+:(?:group|private):[^:]+|qq_(?:group|private):\d+)$/.test(item.effect.mailbox)
          || !isPositiveSafeInteger(item.effect.throughRowId)
        ) {
          logRejectedEffect(item, 'invalid_inbox_cursor')
          break
        }
        const current = inboxReads.get(item.effect.mailbox)
        if (!current || item.effect.throughRowId > current.throughRowId) {
          inboxReads.set(item.effect.mailbox, {
            mailbox: item.effect.mailbox,
            throughRowId: item.effect.throughRowId,
          })
        }
        break
      }
    }
  }

  return {
    sentTargets,
    ...(inboxReads.size > 0 ? { inboxReads: [...inboxReads.values()] } : {}),
    ...(workContinuationRequested ? { workContinuationRequested: true } : {}),
  }
}

function parseMessageSentTarget(value: unknown): MessageSentTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  if (!hasExactKeys(target, ['platform', 'accountId', 'kind', 'externalId'])) return null
  if (target.platform !== 'qq' && target.platform !== 'feishu') return null
  if (target.kind !== 'group' && target.kind !== 'private') return null
  if (typeof target.accountId !== 'string' || !target.accountId) return null
  if (typeof target.externalId !== 'string' || !target.externalId) return null
  return {
    platform: target.platform,
    accountId: target.accountId,
    kind: target.kind,
    externalId: target.externalId,
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function logRejectedEffect(item: ReactToolEffect, reason: string): void {
  log.warn(
    { toolName: item.toolName, toolCallId: item.toolCallId, effectType: item.effect.type, reason },
    'tool_effect_rejected',
  )
}
