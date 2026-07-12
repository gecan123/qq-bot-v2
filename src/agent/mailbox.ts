import type { BotEvent } from './event.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export type MailboxCursors = Record<string, number>
export const MAILBOX_BACKLOG_THRESHOLD = 100
export const MAILBOX_BACKLOG_RECENT_LIMIT = 50

type MessageEvent = Extract<BotEvent, { type: 'napcat_message' | 'napcat_private_message' }>
type MailboxEvent = MessageEvent
type MailboxBacklogEvent = Extract<BotEvent, { type: 'mailbox_backlog' }>

export type MailboxDisclosure =
  | { kind: 'direct'; event: BotEvent }
  | { kind: 'mailbox'; mailboxKey: string; events: MailboxEvent[] }
  | { kind: 'backlog'; event: MailboxBacklogEvent }

export interface MailboxDisclosurePlan {
  disclosures: MailboxDisclosure[]
  cursors: MailboxCursors
}

export interface MailboxNotificationOptions {
  contextBefore?: number
}

export function mailboxKeyForEvent(event: BotEvent): string | null {
  if (event.type === 'napcat_message') return `qq_group:${event.groupId}`
  if (event.type === 'napcat_private_message') return `qq_private:${event.peerId}`
  if (event.type === 'mailbox_backlog') return event.mailboxKey
  return null
}

export function planMailboxDisclosures(
  events: readonly BotEvent[],
  currentCursors: Readonly<MailboxCursors>,
): MailboxDisclosurePlan {
  const cursors: MailboxCursors = { ...currentCursors }
  const disclosures: MailboxDisclosure[] = []
  const mailboxEventsByKey = new Map<string, MailboxEvent[]>()

  for (const event of events) {
    const mailboxKey = mailboxKeyForEvent(event)
    if (mailboxKey == null) {
      disclosures.push({ kind: 'direct', event })
      continue
    }

    if (event.type === 'mailbox_backlog') {
      if (event.throughRowId <= (cursors[mailboxKey] ?? 0)) continue
      cursors[mailboxKey] = event.throughRowId
      disclosures.push({ kind: 'backlog', event })
      continue
    }

    const message = event as MessageEvent
    if (message.messageRowId <= (cursors[mailboxKey] ?? 0)) continue
    cursors[mailboxKey] = message.messageRowId

    const existing = mailboxEventsByKey.get(mailboxKey)
    if (existing) {
      existing.push(message)
    } else {
      const batch = [message]
      mailboxEventsByKey.set(mailboxKey, batch)
      disclosures.push({ kind: 'mailbox', mailboxKey, events: batch })
    }
  }

  return { disclosures, cursors }
}

export function renderMailboxNotification(
  mailboxKey: string,
  events: readonly MailboxEvent[],
  options: MailboxNotificationOptions = {},
): string {
  if (events.length === 0) {
    throw new Error('mailbox notification requires at least one event')
  }

  const first = events[0]!
  const last = events[events.length - 1]!
  const senderCount = new Set(events.map((event) => event.senderId)).size
  const priority = events.some((event) => (
    event.type === 'napcat_private_message' || event.mentionedSelf
  )) ? 'high' : 'normal'
  const afterRowId = Math.max(0, first.messageRowId - 1)
  const throughRowId = last.messageRowId
  const timeRange = {
    from: formatBeijingIso(first.sentAt),
    to: formatBeijingIso(last.sentAt),
  }
  const contextArgs = options.contextBefore == null || options.contextBefore <= 0
    ? {}
    : { contextBefore: options.contextBefore }
  const source = first.type === 'napcat_private_message'
    ? {
        value: { type: 'private', peerId: first.peerId, senderName: first.senderNickname },
        readArgs: { action: 'read', source: 'private', peerId: first.peerId, afterRowId, ...contextArgs },
      }
    : {
        value: { type: 'group', groupId: first.groupId, groupName: first.groupName ?? null },
        readArgs: { action: 'read', source: 'group', groupId: first.groupId, afterRowId, ...contextArgs },
      }

  const payload = {
    event: 'inbox_update',
    mailbox: mailboxKey,
    priority,
    source: source.value,
    count: events.length,
    firstRowId: first.messageRowId,
    throughRowId,
    senderCount,
    timeRange,
    readArgs: source.readArgs,
  }

  if (events.length <= MAILBOX_BACKLOG_THRESHOLD) {
    return JSON.stringify(payload)
  }

  const firstRecent = events[Math.max(0, events.length - MAILBOX_BACKLOG_RECENT_LIMIT)]!
  return JSON.stringify({
    ...payload,
    mode: 'backlog',
    latestReadArgs: recentReadArgsForEvent(firstRecent),
  })
}

export function renderMailboxBacklogNotification(event: MailboxBacklogEvent): string {
  return JSON.stringify({
    event: 'inbox_update',
    mode: 'backlog',
    mailbox: event.mailboxKey,
    priority: event.priority,
    source: event.source,
    count: event.count,
    firstRowId: event.firstRowId,
    throughRowId: event.throughRowId,
    senderCount: event.senderCount,
    timeRange: {
      from: formatBeijingIso(event.timeRange.from),
      to: formatBeijingIso(event.timeRange.to),
    },
    readArgs: readArgsForSource(event.source, Math.max(0, event.firstRowId - 1)),
    latestReadArgs: {
      ...readArgsForSource(event.source, event.recentAfterRowId),
      limit: MAILBOX_BACKLOG_RECENT_LIMIT,
    },
  })
}

function recentReadArgsForEvent(event: MailboxEvent): Record<string, unknown> {
  const afterRowId = Math.max(0, event.messageRowId - 1)
  if (event.type === 'napcat_private_message') {
    return { action: 'read', source: 'private', peerId: event.peerId, afterRowId, limit: MAILBOX_BACKLOG_RECENT_LIMIT }
  }
  return { action: 'read', source: 'group', groupId: event.groupId, afterRowId, limit: MAILBOX_BACKLOG_RECENT_LIMIT }
}

function readArgsForSource(source: MailboxBacklogEvent['source'], afterRowId: number): Record<string, unknown> {
  if (source.type === 'private') {
    return { action: 'read', source: 'private', peerId: source.peerId, afterRowId }
  }
  return { action: 'read', source: 'group', groupId: source.groupId, afterRowId }
}
