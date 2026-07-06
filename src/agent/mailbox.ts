import type { BotEvent } from './event.js'

export type MailboxCursors = Record<string, number>

type MessageEvent = Extract<BotEvent, { type: 'napcat_message' | 'napcat_private_message' }>
type MailboxEvent = MessageEvent

export type MailboxDisclosure =
  | { kind: 'direct'; event: BotEvent }
  | { kind: 'mailbox'; mailboxKey: string; events: MailboxEvent[] }

export interface MailboxDisclosurePlan {
  disclosures: MailboxDisclosure[]
  cursors: MailboxCursors
}

export function mailboxKeyForEvent(event: BotEvent): string | null {
  if (event.type === 'napcat_message') return `qq_group:${event.groupId}`
  if (event.type === 'napcat_private_message') return `qq_private:${event.peerId}`
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
    from: first.sentAt.toISOString(),
    to: last.sentAt.toISOString(),
  }
  const source = first.type === 'napcat_private_message'
    ? {
        value: { type: 'private', peerId: first.peerId, senderName: first.senderNickname },
        readArgs: { action: 'read', source: 'private', peerId: first.peerId, afterRowId },
      }
    : {
        value: { type: 'group', groupId: first.groupId, groupName: first.groupName ?? null },
        readArgs: { action: 'read', source: 'group', groupId: first.groupId, afterRowId },
      }

  return JSON.stringify({
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
  })
}
