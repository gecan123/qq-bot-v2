import type { BotEvent } from './event.js'

export type NotificationPriority = 'high' | 'normal' | 'low'
export type NotificationDelivery = 'interrupt' | 'next_round' | 'passive'

export interface NotificationOpenAction {
  tool: string
  args: Record<string, unknown>
}

export interface NotificationEnvelopeInput {
  id: string
  source: Record<string, unknown>
  kind: string
  priority: NotificationPriority
  delivery: NotificationDelivery
  groupKey: string
  count: number
  occurredAt?: string
  open: NotificationOpenAction
  data?: Record<string, unknown>
}

export interface NotificationRouting {
  priority: NotificationPriority
  delivery: NotificationDelivery
}

export function renderNotificationEnvelope(input: NotificationEnvelopeInput): string {
  if (!Number.isSafeInteger(input.count) || input.count <= 0) {
    throw new RangeError('notification count must be a positive safe integer')
  }
  return JSON.stringify({
    event: 'notification',
    id: input.id,
    source: input.source,
    kind: input.kind,
    priority: input.priority,
    delivery: input.delivery,
    groupKey: input.groupKey,
    count: input.count,
    ...(input.occurredAt == null ? {} : { occurredAt: input.occurredAt }),
    open: input.open,
    ...(input.data == null ? {} : { data: input.data }),
  })
}

export function notificationRoutingForEvent(event: BotEvent): NotificationRouting | null {
  if (event.type === 'napcat_private_message') {
    return { priority: 'high', delivery: 'interrupt' }
  }
  if (event.type === 'napcat_message') {
    return event.mentionedSelf
      ? { priority: 'high', delivery: 'interrupt' }
      : { priority: 'normal', delivery: 'passive' }
  }
  if (event.type === 'mailbox_backlog') {
    return event.priority === 'high'
      ? { priority: 'high', delivery: 'interrupt' }
      : { priority: 'normal', delivery: 'passive' }
  }
  if (event.type === 'scheduled_wake') {
    return { priority: 'normal', delivery: 'interrupt' }
  }
  if (event.type === 'background_task_completed') {
    return {
      priority: event.ok ? 'normal' : 'high',
      delivery: 'interrupt',
    }
  }
  return null
}

export function isAttentionEvent(event: BotEvent): boolean {
  if (event.type === 'wake') return true
  return notificationRoutingForEvent(event)?.delivery === 'interrupt'
}
