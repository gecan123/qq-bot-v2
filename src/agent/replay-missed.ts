import type { Prisma, Message } from '../generated/prisma/client.js'
import type { ChatPlatform, ConversationRef } from '../chat/conversation.js'
import { conversationKey } from '../chat/conversation.js'
import { prisma } from '../database/client.js'
import { ensureMessageReadyForAgent as defaultEnsureReady } from '../media/ensure-message-ready.js'
import { messageRowToChatEvent } from '../services/database-mailbox-watcher.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { BotEvent } from './event.js'
import {
  MAILBOX_BACKLOG_RECENT_LIMIT,
  MAILBOX_BACKLOG_THRESHOLD,
  type MailboxCursors,
} from './mailbox.js'

const log = createLogger('REPLAY')

export interface ReplayMissedDeps {
  enqueueMessageEvent: (event: BotEvent) => boolean | Promise<boolean>
  allowedConversations: readonly ConversationRef[]
  selfExternalIds: Partial<Record<ChatPlatform, string>>
  /** 普通群消息可以形成 passive notification 的会话 key。 */
  passiveConversationKeys?: readonly string[]
  ensureReady?: (message: Message) => Promise<{ renderedText: string; fromFrozen: boolean }>
}

export interface ReplayCheckpoint {
  mailboxCursors: Readonly<MailboxCursors>
  legacyLastWakeAt: Date | null
}

interface ReplaySource {
  mailboxKey: string
  conversation: ConversationRef
  where: Prisma.MessageWhereInput
  attentionWhere: Prisma.MessageWhereInput | null
}

interface ReplayCounters {
  enqueued: number
  skippedDuplicates: number
}

export async function replayMissedMessages(
  checkpoint: ReplayCheckpoint,
  deps: ReplayMissedDeps,
): Promise<ReplayCounters> {
  if (Object.keys(checkpoint.mailboxCursors).length === 0 && !checkpoint.legacyLastWakeAt) {
    log.info('mailbox cursors and lastWakeAt are empty; skipping replay')
    return { enqueued: 0, skippedDuplicates: 0 }
  }

  const passiveKeys = new Set(deps.passiveConversationKeys ?? [])
  const sources = deps.allowedConversations.flatMap((conversation): ReplaySource[] => {
    const selfExternalId = deps.selfExternalIds[conversation.platform]
    if (!selfExternalId) return []
    const mailboxKey = conversationKey(conversation)
    const cursor = checkpoint.mailboxCursors[mailboxKey]
    const boundary: Prisma.MessageWhereInput | null = cursor != null
      ? { rowId: { gt: cursor } }
      : checkpoint.legacyLastWakeAt
        ? { createdAt: { gt: checkpoint.legacyLastWakeAt } }
        : null
    if (!boundary) return []

    const baseWhere: Prisma.MessageWhereInput = {
      platform: conversation.platform,
      accountId: conversation.accountId,
      conversationKind: conversation.kind,
      conversationExternalId: conversation.externalId,
      senderExternalId: { not: selfExternalId },
      ...boundary,
    }
    const attentionWhere: Prisma.MessageWhereInput | null = conversation.kind === 'group'
      ? {
          ...baseWhere,
          OR: [
            { eventKind: { in: ['edit', 'recall'] } },
            {
              eventKind: 'message',
              content: { array_contains: [{ type: 'at', targetId: selfExternalId }] },
            },
          ],
        }
      : null

    return [{
      mailboxKey,
      conversation,
      where: attentionWhere && !passiveKeys.has(mailboxKey) ? attentionWhere : baseWhere,
      attentionWhere,
    }]
  })

  if (sources.length === 0) {
    log.info('no replayable mailbox sources')
    return { enqueued: 0, skippedDuplicates: 0 }
  }

  const totals: ReplayCounters = { enqueued: 0, skippedDuplicates: 0 }
  for (const source of sources) {
    const result = await replaySource(source, checkpoint, deps, passiveKeys)
    totals.enqueued += result.enqueued
    totals.skippedDuplicates += result.skippedDuplicates
  }

  log.info({
    ...totals,
    cursorSources: Object.keys(checkpoint.mailboxCursors).length,
    legacySince: checkpoint.legacyLastWakeAt ? formatBeijingIso(checkpoint.legacyLastWakeAt) : null,
  }, '回放关机期间消息')
  return totals
}

async function replaySource(
  source: ReplaySource,
  checkpoint: ReplayCheckpoint,
  deps: ReplayMissedDeps,
  passiveKeys: ReadonlySet<string>,
): Promise<ReplayCounters> {
  const rows = await prisma.message.findMany({
    where: source.where,
    orderBy: { rowId: 'asc' },
    take: MAILBOX_BACKLOG_THRESHOLD + 1,
  })

  if (rows.length <= MAILBOX_BACKLOG_THRESHOLD) {
    return enqueueReplayRows(rows, checkpoint, deps, passiveKeys)
  }

  const count = await prisma.message.count({ where: source.where })
  const containsAttention = source.conversation.kind === 'private'
    || (source.attentionWhere != null && await prisma.message.findFirst({
      where: source.attentionWhere,
      select: { rowId: true },
    }) != null)
  const first = rows[0]!
  const last = await prisma.message.findFirst({
    where: source.where,
    orderBy: { rowId: 'desc' },
  }) ?? rows[rows.length - 1]!
  const recentFirst = await prisma.message.findFirst({
    where: source.where,
    orderBy: { rowId: 'asc' },
    skip: Math.max(0, count - MAILBOX_BACKLOG_RECENT_LIMIT),
  }) ?? last

  const event: BotEvent = {
    type: 'mailbox_backlog',
    mailboxKey: source.mailboxKey,
    priority: containsAttention ? 'high' : 'normal',
    source: {
      type: 'conversation',
      conversation: source.conversation,
      name: first.conversationName,
      senderName: first.senderConversationName ?? first.senderName,
    },
    count,
    firstRowId: first.rowId,
    throughRowId: last.rowId,
    recentAfterRowId: Math.max(0, recentFirst.rowId - 1),
    senderCount: null,
    timeRange: {
      from: first.sentAt ?? first.createdAt,
      to: last.sentAt ?? last.createdAt,
    },
  }

  return await deps.enqueueMessageEvent(event)
    ? { enqueued: 1, skippedDuplicates: 0 }
    : { enqueued: 0, skippedDuplicates: 1 }
}

async function enqueueReplayRows(
  rows: readonly Message[],
  checkpoint: ReplayCheckpoint,
  deps: ReplayMissedDeps,
  passiveKeys: ReadonlySet<string>,
): Promise<ReplayCounters> {
  const ensureReady = deps.ensureReady ?? defaultEnsureReady
  let enqueued = 0
  let skippedDuplicates = 0

  for (const row of rows) {
    const conversation: ConversationRef = {
      platform: asPlatform(row.platform),
      accountId: row.accountId,
      kind: asConversationKind(row.conversationKind),
      externalId: row.conversationExternalId,
    }
    const mailboxKey = conversationKey(conversation)
    const cursor = checkpoint.mailboxCursors[mailboxKey]
    const afterBoundary = cursor != null
      ? row.rowId > cursor
      : checkpoint.legacyLastWakeAt != null && row.createdAt > checkpoint.legacyLastWakeAt
    if (!afterBoundary) continue

    const selfExternalId = deps.selfExternalIds[conversation.platform]
    if (!selfExternalId || row.senderExternalId === selfExternalId) continue
    if (
      conversation.kind === 'group'
      && row.eventKind === 'message'
      && !passiveKeys.has(mailboxKey)
      && !messageMentions(row.content, selfExternalId)
    ) continue

    const ready = await ensureReady(row)
    const accepted = await deps.enqueueMessageEvent(
      messageRowToChatEvent(row, ready.renderedText, selfExternalId),
    )
    if (accepted) enqueued++
    else skippedDuplicates++
  }

  return { enqueued, skippedDuplicates }
}

function asPlatform(value: string): ChatPlatform {
  if (value === 'qq' || value === 'feishu') return value
  throw new Error(`unsupported replay platform: ${value}`)
}

function asConversationKind(value: string): ConversationRef['kind'] {
  if (value === 'group' || value === 'private') return value
  throw new Error(`unsupported replay conversation kind: ${value}`)
}

function messageMentions(content: unknown, selfExternalId: string): boolean {
  if (!Array.isArray(content)) return false
  return content.some((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const value = segment as Record<string, unknown>
    return value.type === 'at' && value.targetId === selfExternalId
  })
}
