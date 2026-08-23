import type { GroupPolicy } from '../config/group-policies.js'
import { prisma } from '../database/client.js'
import { ensureMessageReadyForAgent } from '../media/ensure-message-ready.js'
import type { BotEvent } from '../agent/event.js'
import type { ChatMessageEvent } from '../agent/event.js'
import { createLogger } from '../logger.js'
import type { Message } from '../generated/prisma/client.js'
import type { ChatPlatform, ConversationKind } from '../chat/conversation.js'
import { conversationKey } from '../chat/conversation.js'
import {
  initialMailboxWatcherStatus,
  MAILBOX_WATCHER_STATUS_PATH,
  recordMailboxWatcherFailure,
  recordMailboxWatcherSuccess,
  shouldPublishMailboxWatcherStatus,
  type MailboxWatcherStatus,
  writeMailboxWatcherStatus,
} from './mailbox-watcher-status.js'

const log = createLogger('MAILBOX_WATCHER')

export interface DatabaseMailboxWatcher {
  start(): void
  stop(): Promise<void>
  cursor(): number
  status(): MailboxWatcherStatus
}

export async function currentMessageHighWater(): Promise<number> {
  const result = await prisma.message.aggregate({ _max: { rowId: true } })
  return result._max.rowId ?? 0
}

function chatPlatform(value: string): ChatPlatform {
  if (value === 'qq' || value === 'feishu') return value
  throw new Error(`unsupported chat platform: ${value}`)
}

function conversationKind(value: string): ConversationKind {
  if (value === 'group' || value === 'private') return value
  throw new Error(`unsupported conversation kind: ${value}`)
}

export function messageRowToChatEvent(
  row: Message,
  renderedText: string,
  selfExternalId: string,
): ChatMessageEvent {
  const conversation = {
    platform: chatPlatform(row.platform),
    accountId: row.accountId,
    kind: conversationKind(row.conversationKind),
    externalId: row.conversationExternalId,
  }
  const eventKind = row.eventKind === 'message' || row.eventKind === 'edit' || row.eventKind === 'recall'
    ? row.eventKind
    : (() => { throw new Error(`unsupported message event kind: ${row.eventKind}`) })()
  const lifecycleText = eventKind === 'recall'
    ? `[消息已撤回: ${row.messageExternalId}]`
    : eventKind === 'edit'
      ? `[消息已编辑: ${row.messageExternalId}]${renderedText ? `\n${renderedText}` : ''}`
      : renderedText

  return {
    type: 'chat_message',
    eventKind,
    messageRowId: row.rowId,
    conversation,
    ...(row.conversationName ? { conversationName: row.conversationName } : {}),
    messageExternalId: row.messageExternalId,
    ...(row.replyToExternalId ? { replyToExternalId: row.replyToExternalId } : {}),
    ...(row.threadExternalId ? { threadExternalId: row.threadExternalId } : {}),
    senderExternalId: row.senderExternalId,
    senderName: row.senderConversationName ?? row.senderName ?? row.senderExternalId,
    mentionedSelf: conversation.kind === 'private' || messageMentions(row.content, selfExternalId),
    sentAt: row.sentAt ?? row.createdAt,
    renderedText: lifecycleText,
  }
}

export function createDatabaseMailboxWatcher(input: {
  startAfterRowId: number
  pollMs: number
  selfNumber: number
  groupPolicies: readonly GroupPolicy[]
  selfExternalIds?: Partial<Record<ChatPlatform, string>>
  allowedConversationKeys?: ReadonlySet<string>
  enqueue: (event: BotEvent) => void | Promise<void>
  statusPath?: string
  writeStatus?: (path: string, status: MailboxWatcherStatus) => Promise<void>
  statusHeartbeatMs?: number
  now?: () => Date
}): DatabaseMailboxWatcher {
  const policies = new Map(input.groupPolicies.map((policy) => [policy.id, policy]))
  let cursor = input.startAfterRowId
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let polling = false
  let activePoll: Promise<void> | null = null
  let processingRowId: number | null = null
  const now = input.now ?? (() => new Date())
  let status = initialMailboxWatcherStatus(cursor, now())
  let statusWriteTail = Promise.resolve()
  let lastPublishedStatus: MailboxWatcherStatus | null = null
  let lastPublishedAtMs: number | null = null
  const statusPath = input.statusPath ?? MAILBOX_WATCHER_STATUS_PATH
  const writeStatus = input.writeStatus ?? writeMailboxWatcherStatus
  const statusHeartbeatMs = Math.max(1_000, input.statusHeartbeatMs ?? 60_000)

  const publishStatus = (): void => {
    const publishedAtMs = now().getTime()
    if (!shouldPublishMailboxWatcherStatus({
      current: status,
      previous: lastPublishedStatus,
      lastPublishedAtMs,
      nowMs: publishedAtMs,
      heartbeatMs: statusHeartbeatMs,
    })) return
    const snapshot = structuredClone(status)
    lastPublishedStatus = snapshot
    lastPublishedAtMs = publishedAtMs
    statusWriteTail = statusWriteTail
      .then(() => writeStatus(statusPath, snapshot))
      .catch((error: unknown) => log.warn({ error, statusPath }, 'mailbox_watcher_status_write_failed'))
  }

  const schedule = (delayMs: number): void => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      activePoll = poll().finally(() => {
        activePoll = null
      })
    }, delayMs)
  }

  const poll = async (): Promise<void> => {
    if (stopped || polling) return
    polling = true
    try {
      const rows = await prisma.message.findMany({
        where: {
          rowId: { gt: cursor },
        },
        orderBy: { rowId: 'asc' },
        take: 200,
      })
      for (const row of rows) {
        processingRowId = row.rowId
        const platform = chatPlatform(row.platform)
        const selfExternalId = input.selfExternalIds?.[platform]
          ?? (platform === 'qq' ? String(input.selfNumber) : '')
        if (!selfExternalId || row.senderExternalId === selfExternalId) {
          cursor = row.rowId
          continue
        }
        const ref = {
          platform,
          accountId: row.accountId,
          kind: conversationKind(row.conversationKind),
          externalId: row.conversationExternalId,
        }
        if (ref.kind === 'group') {
          const qqGroupId = ref.platform === 'qq' ? Number(ref.externalId) : null
          const policy = qqGroupId != null && Number.isSafeInteger(qqGroupId)
            ? policies.get(qqGroupId)
            : undefined
          const allowed = policy != null || input.allowedConversationKeys?.has(conversationKey(ref)) === true
          if (!allowed) {
            cursor = row.rowId
            continue
          }
          const mentionedSelf = messageMentions(row.content, selfExternalId)
          if (row.eventKind === 'message' && policy?.participation === 'mentions' && !mentionedSelf) {
            cursor = row.rowId
            continue
          }
        }
        const ready = await ensureMessageReadyForAgent(row)
        await input.enqueue(messageRowToChatEvent(row, ready.renderedText, selfExternalId))
        cursor = row.rowId
        processingRowId = null
      }
      status = recordMailboxWatcherSuccess(status, cursor, now())
      publishStatus()
      schedule(rows.length === 200 ? 0 : input.pollMs)
    } catch (error) {
      status = recordMailboxWatcherFailure(status, processingRowId, error, now())
      publishStatus()
      log.error({ error, cursor, blockedAtRowId: processingRowId }, 'database_mailbox_poll_failed')
      processingRowId = null
      schedule(input.pollMs)
    } finally {
      polling = false
    }
  }

  return {
    start() {
      stopped = false
      publishStatus()
      schedule(0)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      await activePoll
      await statusWriteTail
    },
    cursor: () => cursor,
    status: () => structuredClone(status),
  }
}

function messageMentions(content: unknown, selfExternalId: string): boolean {
  if (!Array.isArray(content)) return false
  return content.some((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const value = segment as Record<string, unknown>
    return value.type === 'at' && value.targetId === selfExternalId
  })
}
