import type { BotEvent } from './event.js'
import { formatBeijingMinuteIso } from '../utils/beijing-time.js'
import type { GroupParticipation } from '../config/group-policies.js'
import { renderNotificationEnvelope } from './notification.js'
import { conversationKey } from '../chat/conversation.js'

export type MailboxCursors = Record<string, number>
export const MAILBOX_BACKLOG_THRESHOLD = 100
export const MAILBOX_BACKLOG_RECENT_LIMIT = 50
export const MAILBOX_DELTA_OUTPUT_CAP_CHARS = 12_000
const MAILBOX_DELTA_TEXT_CAP_CHARS = 2_000
const MAILBOX_KEY_PATTERN = /^(?:qq_(?:group|private):\d+|(?:qq|feishu):[^:]+:(?:group|private):[^:]+)$/

export function isMailboxKey(value: unknown): value is string {
  return typeof value === 'string' && MAILBOX_KEY_PATTERN.test(value)
}

type MessageEvent = Extract<BotEvent, {
  type: 'chat_message' | 'napcat_message' | 'napcat_private_message'
}>
type MailboxEvent = MessageEvent
type MailboxBacklogEvent = Extract<BotEvent, { type: 'mailbox_backlog' }>

export type MailboxDisclosure =
  | { kind: 'direct'; event: BotEvent }
  | { kind: 'mailbox'; mailboxKey: string; events: MailboxEvent[] }
  | { kind: 'backlog'; event: MailboxBacklogEvent }

export type MailboxMessageDisclosure = Extract<MailboxDisclosure, { kind: 'mailbox' }>

export interface MailboxDisclosurePlan {
  disclosures: MailboxDisclosure[]
  cursors: MailboxCursors
}

export interface MailboxNotificationOptions {
  contextBefore?: number
  participation?: GroupParticipation
}

export function mailboxKeyForEvent(event: BotEvent): string | null {
  if (event.type === 'chat_message') return conversationKey(event.conversation)
  if (event.type === 'napcat_message') return `qq_group:${event.groupId}`
  if (event.type === 'napcat_private_message') return `qq_private:${event.peerId}`
  if (event.type === 'mailbox_backlog') return event.mailboxKey
  return null
}

export function isHighPriorityMailboxDisclosure(disclosure: MailboxDisclosure): boolean {
  if (disclosure.kind === 'backlog') return disclosure.event.priority === 'high'
  if (disclosure.kind !== 'mailbox') return false
  return disclosure.events.some(isHighPriorityMailboxEvent)
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
  const senderCount = new Set(events.map(senderExternalIdForEvent)).size
  const priority = events.some(isHighPriorityMailboxEvent) ? 'high' : 'normal'
  const afterRowId = Math.max(0, first.messageRowId - 1)
  const throughRowId = last.messageRowId
  const timeRange = {
    from: formatBeijingMinuteIso(first.sentAt),
    to: formatBeijingMinuteIso(last.sentAt),
  }
  const contextArgs = options.contextBefore == null || options.contextBefore <= 0
    ? {}
    : { contextBefore: options.contextBefore }
  const source = first.type === 'chat_message'
    ? {
        value: {
          ...first.conversation,
          name: first.conversationName ?? null,
        },
        readArgs: {
          action: 'read',
          conversation: first.conversation,
          afterRowId,
          ...contextArgs,
        },
      }
    : first.type === 'napcat_private_message'
    ? {
        value: { type: 'private', peerId: first.peerId, senderName: first.senderNickname },
        readArgs: { action: 'read', source: 'private', peerId: first.peerId, afterRowId, ...contextArgs },
      }
    : {
        value: { type: 'group', groupId: first.groupId, groupName: first.groupName ?? null },
        readArgs: { action: 'read', source: 'group', groupId: first.groupId, afterRowId, ...contextArgs },
      }

  const data = {
    mailbox: mailboxKey,
    ...(first.type === 'chat_message'
      ? { conversation: source.value }
      : { qqSource: source.value }),
    ...((first.type === 'chat_message' ? first.conversation.kind === 'group' : first.type === 'napcat_message')
      && options.participation
      ? { participation: options.participation }
      : {}),
    firstRowId: first.messageRowId,
    throughRowId,
    senderCount,
    ...(events.length === 1 ? {} : { timeRange }),
    readArgs: source.readArgs,
  }

  const platform = first.type === 'chat_message' ? first.conversation.platform : 'qq'
  return renderNotificationEnvelope({
    id: `${platform}:${mailboxKey}:${throughRowId}`,
    source: { type: platform, mailbox: mailboxKey },
    kind: 'inbox_update',
    priority,
    delivery: priority === 'high' ? 'interrupt' : 'passive',
    groupKey: mailboxKey,
    count: events.length,
    ...(events.length === 1 ? { occurredAt: timeRange.to } : {}),
    open: { tool: 'inbox', args: source.readArgs },
    data,
  })
}

export function renderMailboxDeltaBatch(
  disclosures: readonly MailboxMessageDisclosure[],
): string | null {
  if (disclosures.length === 0) {
    throw new Error('mailbox delta batch requires at least one disclosure')
  }
  const content = JSON.stringify({
    event: 'conversation_deltas',
    mailboxes: disclosures.map((disclosure) => {
      const first = disclosure.events[0]!
      const last = disclosure.events.at(-1)!
      return {
        mailbox: disclosure.mailboxKey,
        throughRowId: last.messageRowId,
        priority: disclosure.events.some(isHighPriorityMailboxEvent) ? 'high' : 'normal',
        ...(first.type === 'chat_message'
          ? {
              conversation: {
                ...first.conversation,
                ...(first.conversationName ? { name: first.conversationName } : {}),
              },
            }
          : first.type === 'napcat_message'
            ? { qqSource: { type: 'group', groupId: first.groupId, ...(first.groupName ? { groupName: first.groupName } : {}) } }
            : { qqSource: { type: 'private', peerId: first.peerId, senderName: first.senderNickname } }),
        messages: disclosure.events.map(projectDeltaMessage),
      }
    }),
  })
  return content.length <= MAILBOX_DELTA_OUTPUT_CAP_CHARS ? content : null
}

function projectDeltaMessage(event: MailboxEvent): Record<string, unknown> {
  const textTruncated = event.renderedText.length > MAILBOX_DELTA_TEXT_CAP_CHARS
  const text = textTruncated
    ? `${event.renderedText.slice(0, MAILBOX_DELTA_TEXT_CAP_CHARS)}…`
    : event.renderedText
  if (event.type === 'chat_message') {
    return {
      rowId: event.messageRowId,
      ...(event.eventKind === 'message' ? {} : { eventKind: event.eventKind }),
      sentAt: formatBeijingMinuteIso(event.sentAt),
      senderExternalId: event.senderExternalId,
      senderName: event.senderName,
      ...(event.mentionedSelf ? { mentionedSelf: true } : {}),
      ...(event.eventKind === 'recall' ? { replyable: false } : {}),
      ...(event.replyToExternalId ? { replyToExternalId: event.replyToExternalId } : {}),
      ...(event.rootExternalId ? { rootExternalId: event.rootExternalId } : {}),
      ...(event.threadExternalId ? { threadExternalId: event.threadExternalId } : {}),
      text,
      ...(textTruncated ? { textTruncated: true } : {}),
      ...(event.mediaIds && event.mediaIds.length > 0 ? { mediaIds: event.mediaIds } : {}),
    }
  }
  return {
    rowId: event.messageRowId,
    sentAt: formatBeijingMinuteIso(event.sentAt),
    senderExternalId: String(event.senderId),
    senderName: event.senderNickname,
    ...(event.mentionedSelf ? { mentionedSelf: true } : {}),
    text,
    ...(textTruncated ? { textTruncated: true } : {}),
  }
}

export function renderMailboxBacklogNotification(
  event: MailboxBacklogEvent,
  options: Pick<MailboxNotificationOptions, 'participation'> = {},
): string {
  const readArgs = readArgsForSource(event.source, Math.max(0, event.firstRowId - 1))
  const latestReadArgs = {
    ...readArgsForSource(event.source, event.recentAfterRowId),
    limit: MAILBOX_BACKLOG_RECENT_LIMIT,
  }
  const timeRange = {
    from: formatBeijingMinuteIso(event.timeRange.from),
    to: formatBeijingMinuteIso(event.timeRange.to),
  }
  const platform = event.source.type === 'conversation'
    ? event.source.conversation.platform
    : 'qq'
  const sourceData = event.source.type === 'conversation'
    ? {
        conversation: {
          ...event.source.conversation,
          name: event.source.name,
        },
      }
    : { qqSource: event.source }
  return renderNotificationEnvelope({
    id: `${platform}:${event.mailboxKey}:${event.throughRowId}`,
    source: { type: platform, mailbox: event.mailboxKey },
    kind: 'inbox_update',
    priority: event.priority,
    delivery: event.priority === 'high' ? 'interrupt' : 'passive',
    groupKey: event.mailboxKey,
    count: event.count,
    ...(event.count === 1 ? { occurredAt: timeRange.to } : {}),
    open: { tool: 'inbox', args: event.priority === 'high' ? readArgs : latestReadArgs },
    data: {
      mode: 'backlog',
      mailbox: event.mailboxKey,
      ...sourceData,
      ...((event.source.type === 'group'
        || (event.source.type === 'conversation' && event.source.conversation.kind === 'group'))
      && options.participation
        ? { participation: options.participation }
        : {}),
      firstRowId: event.firstRowId,
      throughRowId: event.throughRowId,
      senderCount: event.senderCount,
      ...(event.count === 1 ? {} : { timeRange }),
      readArgs,
      latestReadArgs,
    },
  })
}

function isHighPriorityMailboxEvent(event: MailboxEvent): boolean {
  return event.type === 'chat_message'
    ? event.eventKind !== 'message' || event.conversation.kind === 'private' || event.mentionedSelf
    : event.type === 'napcat_private_message' || event.mentionedSelf
}

function senderExternalIdForEvent(event: MailboxEvent): string {
  return event.type === 'chat_message' ? event.senderExternalId : String(event.senderId)
}

function readArgsForSource(source: MailboxBacklogEvent['source'], afterRowId: number): Record<string, unknown> {
  if (source.type === 'conversation') {
    return { action: 'read', conversation: source.conversation, afterRowId }
  }
  if (source.type === 'private') {
    return { action: 'read', source: 'private', peerId: source.peerId, afterRowId }
  }
  return { action: 'read', source: 'group', groupId: source.groupId, afterRowId }
}
