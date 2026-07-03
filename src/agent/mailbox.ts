import type { BotEvent } from './event.js'

export type MailboxCursors = Record<string, number>

type MessageEvent = Extract<BotEvent, { type: 'napcat_message' | 'napcat_private_message' }>
type AmbientGroupEvent = Extract<BotEvent, { type: 'napcat_message' }>

export type MailboxDisclosure =
  | { kind: 'direct'; event: BotEvent }
  | { kind: 'ambient'; mailboxKey: string; events: AmbientGroupEvent[] }

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
  const ambientByKey = new Map<string, AmbientGroupEvent[]>()

  for (const event of events) {
    const mailboxKey = mailboxKeyForEvent(event)
    if (mailboxKey == null) {
      disclosures.push({ kind: 'direct', event })
      continue
    }

    const message = event as MessageEvent
    if (message.messageRowId <= (cursors[mailboxKey] ?? 0)) continue
    cursors[mailboxKey] = message.messageRowId

    if (event.type === 'napcat_message' && !event.mentionedSelf) {
      const existing = ambientByKey.get(mailboxKey)
      if (existing) {
        existing.push(event)
      } else {
        const batch = [event]
        ambientByKey.set(mailboxKey, batch)
        disclosures.push({ kind: 'ambient', mailboxKey, events: batch })
      }
      continue
    }

    disclosures.push({ kind: 'direct', event })
  }

  return { disclosures, cursors }
}

export function renderAmbientMailboxNotification(
  mailboxKey: string,
  events: readonly AmbientGroupEvent[],
): string {
  if (events.length === 0) {
    throw new Error('ambient mailbox notification requires at least one event')
  }

  const first = events[0]!
  const last = events[events.length - 1]!
  const groupLabel = first.groupName && first.groupName.length > 0
    ? first.groupName
    : String(first.groupId)
  const senderCount = new Set(events.map((event) => event.senderId)).size
  const afterRowId = Math.max(0, first.messageRowId - 1)
  const timeRange = first.sentAt.getTime() === last.sentAt.getTime()
    ? first.sentAt.toISOString()
    : `${first.sentAt.toISOString()}..${last.sentAt.toISOString()}`

  return [
    `[inbox 更新 | 群:${groupLabel} | mailbox=${mailboxKey}]`,
    `新增 ${events.length} 条; rowId ${first.messageRowId}..${last.messageRowId}; 时间 ${timeRange}; 发送者 ${senderCount} 人.`,
    `正文未自动披露. 需要时调用 inbox action=read groupId=${first.groupId} afterRowId=${afterRowId}.`,
  ].join(' ')
}
