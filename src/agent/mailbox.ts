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
  const timeRange = first.sentAt.getTime() === last.sentAt.getTime()
    ? first.sentAt.toISOString()
    : `${first.sentAt.toISOString()}..${last.sentAt.toISOString()}`
  const source = first.type === 'napcat_private_message'
    ? {
        label: `私聊:${first.senderNickname}(QQ:${first.peerId})`,
        read: `inbox action=read source=private peerId=${first.peerId} afterRowId=${afterRowId}`,
      }
    : {
        label: `群:${first.groupName && first.groupName.length > 0 ? first.groupName : first.groupId}`,
        read: `inbox action=read source=group groupId=${first.groupId} afterRowId=${afterRowId}`,
      }

  return [
    `[inbox 更新 | ${source.label} | mailbox=${mailboxKey} | priority=${priority}]`,
    `新增 ${events.length} 条; rowId ${first.messageRowId}..${last.messageRowId}; 时间 ${timeRange}; 发送者 ${senderCount} 人.`,
    `正文未自动披露. 需要时调用 ${source.read}; 本批读取至 throughRowId=${throughRowId}.`,
  ].join(' ')
}
