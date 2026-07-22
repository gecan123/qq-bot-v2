import type { ReactToolEffect } from './react-kernel.js'
import type { InboxReadEffect, MessageSentTarget } from './tool.js'
import { createLogger } from '../logger.js'

const log = createLogger('EFFECT_INTERPRETER')

const PAUSE_EFFECT_TOOLS = new Set(['pause'])

export interface EffectInterpretation {
  didPause: boolean
  didCompleteRest: boolean
  sentTargets: MessageSentTarget[]
  inboxReads?: InboxReadEffect[]
  workContinuationRequested?: true
}

export function interpretToolEffects(effects: ReactToolEffect[]): EffectInterpretation {
  let didPause = false
  let didCompleteRest = false
  const sentTargets: MessageSentTarget[] = []
  const seenSentTargets = new Set<string>()
  const inboxReads = new Map<string, InboxReadEffect>()
  let workContinuationRequested = false

  for (const item of effects) {
    switch (item.effect.type) {
      case 'pause': {
        if (!PAUSE_EFFECT_TOOLS.has(item.toolName)) {
          log.warn(
            { toolName: item.toolName, toolCallId: item.toolCallId, effectType: item.effect.type },
            'tool_effect_rejected',
          )
          break
        }
        didPause = true
        if (item.effect.status === 'elapsed') didCompleteRest = true
        break
      }
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
        const key = target.type === 'group'
          ? `qq_group:${target.groupId}`
          : `qq_private:${target.userId}`
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
          !/^qq_(?:group|private):\d+$/.test(item.effect.mailbox)
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
    didPause,
    didCompleteRest,
    sentTargets,
    ...(inboxReads.size > 0 ? { inboxReads: [...inboxReads.values()] } : {}),
    ...(workContinuationRequested ? { workContinuationRequested: true } : {}),
  }
}

function parseMessageSentTarget(value: unknown): MessageSentTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  if (target.type === 'group') {
    if (!hasExactKeys(target, ['type', 'groupId']) || !isPositiveSafeInteger(target.groupId)) return null
    return { type: 'group', groupId: target.groupId }
  }
  if (target.type === 'private') {
    if (!hasExactKeys(target, ['type', 'userId']) || !isPositiveSafeInteger(target.userId)) return null
    return { type: 'private', userId: target.userId }
  }
  return null
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
