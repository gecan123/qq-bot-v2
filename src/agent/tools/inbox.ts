import { z } from 'zod'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'
import { formatBeijingMinuteIso } from '../../utils/beijing-time.js'
import type { Tool } from '../tool.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import type { InboxReadCursors } from '../inbox-read-cursors.js'
import type { ChatPlatform, ConversationRef } from '../../chat/conversation.js'
import { conversationKey } from '../../chat/conversation.js'

const log = createLogger('INBOX')

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 50
const MAX_CONTEXT_BEFORE = 8
const LIST_SCAN_LIMIT = 500
const MESSAGE_TEXT_CAP_CHARS = 2_000
export const INBOX_OUTPUT_CAP_CHARS = 12_000
const MEDIA_SEGMENT_TYPES = new Set(['image', 'video', 'record', 'file'])

const conversationSchema = z.object({
  platform: z.enum(['qq', 'feishu']),
  accountId: z.string().min(1),
  kind: z.enum(['group', 'private']),
  externalId: z.string().min(1),
})

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('列出当前允许访问且最近有消息的 mailbox.'),
  }),
  z.object({
    action: z.literal('read').describe('按明确来源读取消息正文.'),
    conversation: conversationSchema.describe('必须是允许访问的明确平台会话.'),
    afterRowId: z.number().int().nonnegative().optional().describe('只返回 messages.rowId 大于此值的事实.'),
    contextBefore: z.number().int().min(1).max(MAX_CONTEXT_BEFORE).optional()
      .describe('按通知补偿同一 mailbox 在 afterRowId 之前最近的消息, 最大 8 条.'),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional().describe('返回条数, 默认 20, 最大 50.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface InboxMessageRow {
  rowId: number
  eventKind: string
  platform: string
  accountId: string
  conversationKind: string
  conversationExternalId: string
  conversationName: string | null
  messageExternalId: string
  replyToExternalId?: string | null
  rootExternalId?: string | null
  threadExternalId?: string | null
  senderExternalId: string
  senderName: string | null
  senderConversationName: string | null
  content: unknown
  resolvedText: string | null
  searchText: string
  sentAt: Date | null
  createdAt: Date
}

interface InboxFindManyArgs {
  where: Record<string, unknown>
  orderBy: { rowId: 'asc' | 'desc' }
  take: number
}

export interface InboxToolDeps {
  allowedConversations?: readonly ConversationRef[]
  loadAllowedConversations?: () => Promise<readonly ConversationRef[]>
  selfExternalIds: Partial<Record<ChatPlatform, string>>
  getReadCursors?: () => Readonly<InboxReadCursors>
  getPendingReadDefaults?: (conversation: ConversationRef) => {
    afterRowId: number
    contextBefore?: number
  } | null
  findMessages?: (args: InboxFindManyArgs) => Promise<InboxMessageRow[]>
}

export function createInboxTool(deps: InboxToolDeps): Tool<Args> {
  const loadAllowedConversations = deps.loadAllowedConversations
    ?? (async () => deps.allowedConversations ?? [])
  const findMessages = deps.findMessages ?? defaultFindMessages
  const getReadCursors: () => Readonly<InboxReadCursors> = deps.getReadCursors ?? (() => ({}))
  const progress = createToolResultProgressTracker()

  return {
    name: 'inbox',
    description: [
      '按需查看没有自动进入上下文的 QQ / 飞书 mailbox.',
      'action=list 列出最近有消息的允许会话; action=read 读取一个明确平台会话.',
      'read 结果按 messages.rowId 升序, 用 afterRowId 继续分页.',
      '通知中的 readArgs 可能带 contextBefore, 此时 previousMessages 是 runtime 为长间隔或远距离上下文自动补偿的同 mailbox 前置消息.',
      'inbox 更新通知只是元数据; 需要理解或引用正文时再调用本工具.',
      '需要引用时只把精确目标消息自身的 rowId 填入 send_message.reply_to.row_id；messageExternalId 仅供理解平台关系，不要作为发送参数。不能确认目标时省略引用，不要猜相邻消息。',
      'read 结果中的 media 数组提供媒体的 mediaId、文件名和大小; 图片用 inspect_media 查看，type=file 时可激活 document_reading 后调用 read_file 查看内容.',
      'read 结果中的 mentionedSelf 和 mentionTargets 来自平台结构化 at 段; 正文里的“你”或“@你”只是普通文本, 不代表在叫你.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'list') {
        const allowedConversations = new Map(
          (await loadAllowedConversations())
            .map((conversation) => [conversationKey(conversation), conversation]),
        )
        const sourceFilters = [...allowedConversations.values()].map(conversationWhere)
        const rows = await findMessages({
          where: sourceFilters.length === 0 ? { rowId: { lt: 0 } } : { OR: sourceFilters },
          orderBy: { rowId: 'desc' },
          take: LIST_SCAN_LIMIT,
        })
        const seen = new Set<string>()
        const readCursors = getReadCursors()
        const mailboxes: Array<{
          mailbox: string
          label: string
          latestRowId: number
          lastReadRowId: number
        }> = []
        for (const row of rows) {
          const mailbox = mailboxKeyForRow(row)
          if (seen.has(mailbox)) continue
          seen.add(mailbox)
          const lastReadRowId = readCursors[mailbox] ?? 0
          if (row.rowId <= lastReadRowId) continue
          mailboxes.push({
            mailbox,
            label: row.conversationName
              ?? row.senderConversationName
              ?? row.senderName
              ?? row.conversationExternalId,
            latestRowId: row.rowId,
            lastReadRowId,
          })
        }
        const content = JSON.stringify({
          ok: true,
          pendingOnly: true,
          recentScanTruncated: rows.length === LIST_SCAN_LIMIT,
          mailboxes,
        }, null, 2)
        const changed = progress.observe('list', content)
        return {
          content,
          outcome: { ok: true, code: changed ? 'observed' : 'unchanged', progress: changed },
        }
      }

      const limit = args.limit ?? DEFAULT_READ_LIMIT
      const mailbox = conversationKey(args.conversation)
      const allowedConversations = new Map(
        (await loadAllowedConversations())
          .map((conversation) => [conversationKey(conversation), conversation]),
      )
      const allowed = allowedConversations.get(mailbox)
      if (!allowed) return errorResult(`conversation=${mailbox} is not allowed`)
      const sourceWhere = conversationWhere(allowed)

      const pendingDefaults = args.afterRowId == null
        ? deps.getPendingReadDefaults?.(allowed) ?? null
        : null
      const contextBefore = args.contextBefore ?? pendingDefaults?.contextBefore ?? 0
      const afterRowId = args.afterRowId
        ?? pendingDefaults?.afterRowId
        ?? getReadCursors()[mailbox]
        ?? 0

      const where = { ...sourceWhere, rowId: { gt: afterRowId } }
      const rows = await findMessages({ where, orderBy: { rowId: 'asc' }, take: limit })
      const previousRows = contextBefore > 0 && afterRowId > 0
        ? await findMessages({
            where: { ...sourceWhere, rowId: { lte: afterRowId } },
            orderBy: { rowId: 'desc' },
            take: contextBefore,
          })
        : []
      log.info({
        mailbox,
        afterRowId,
        contextBefore,
        requestedLimit: limit,
        returnedMessages: rows.length,
        returnedPreviousMessages: previousRows.length,
      }, 'inbox_read_completed')
      const content = renderBoundedRead(
        mailbox,
        previousRows,
        rows,
        contextBefore,
        limit,
        deps.selfExternalIds,
      )
      if (rows.length === 0 && previousRows.length === 0) {
        return { content, outcome: { ok: true, code: 'empty', progress: false } }
      }
      const key = JSON.stringify({ mailbox, afterRowId, contextBefore, limit })
      const changed = progress.observe(key, content)
      const renderedMessageRowIds = currentMessageRowIdsFromReadPayload(content)
      const throughRowId = renderedMessageRowIds.at(-1)
      return {
        content,
        ...(throughRowId == null ? {} : {
          effects: [{ type: 'inbox_read' as const, mailbox, throughRowId }],
        }),
        outcome: {
          ok: true,
          code: changed ? 'observed' : 'unchanged',
          progress: changed,
        },
      }
    },
  }
}

function currentMessageRowIdsFromReadPayload(content: string): number[] {
  try {
    const parsed = JSON.parse(content) as { messages?: unknown[] }
    return (parsed.messages ?? [])
      .map((value) => value && typeof value === 'object' ? (value as { rowId?: unknown }).rowId : undefined)
      .filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
  } catch {
    return []
  }
}

function mailboxKeyForRow(row: InboxMessageRow): string {
  return conversationKey(conversationForRow(row))
}

function conversationForRow(row: InboxMessageRow): ConversationRef {
  if (row.platform !== 'qq' && row.platform !== 'feishu') {
    throw new Error(`unsupported inbox platform: ${row.platform}`)
  }
  if (row.conversationKind !== 'group' && row.conversationKind !== 'private') {
    throw new Error(`unsupported inbox conversation kind: ${row.conversationKind}`)
  }
  return {
    platform: row.platform,
    accountId: row.accountId,
    kind: row.conversationKind,
    externalId: row.conversationExternalId,
  }
}

function conversationWhere(conversation: ConversationRef): Record<string, unknown> {
  return {
    platform: conversation.platform,
    accountId: conversation.accountId,
    conversationKind: conversation.kind,
    conversationExternalId: conversation.externalId,
  }
}

function renderBoundedRead(
  mailbox: string,
  previousRowsDescending: readonly InboxMessageRow[],
  rows: readonly InboxMessageRow[],
  requestedContextBefore: number,
  requestedLimit: number,
  selfExternalIds: Partial<Record<ChatPlatform, string>>,
): string {
  const messages: Array<Record<string, unknown>> = []
  const previousMessagesNearestFirst: Array<Record<string, unknown>> = []
  let truncated = false
  for (const row of rows) {
    const projected = projectMessage(row, selfExternalIds)
    const candidate = renderReadPayload(
      mailbox,
      requestedContextBefore,
      requestedLimit,
      reversedCopy(previousMessagesNearestFirst),
      [...messages, projected.value],
      false,
    )
    if (candidate.length > INBOX_OUTPUT_CAP_CHARS) {
      truncated = true
      break
    }
    messages.push(projected.value)
    if (projected.textTruncated) truncated = true
  }
  if (messages.length < rows.length) truncated = true

  for (const row of previousRowsDescending) {
    const projected = projectMessage(row, selfExternalIds)
    const nextPreviousNearestFirst = [...previousMessagesNearestFirst, projected.value]
    const candidate = renderReadPayload(
      mailbox,
      requestedContextBefore,
      requestedLimit,
      reversedCopy(nextPreviousNearestFirst),
      messages,
      truncated,
    )
    if (candidate.length > INBOX_OUTPUT_CAP_CHARS) {
      truncated = true
      break
    }
    previousMessagesNearestFirst.push(projected.value)
    if (projected.textTruncated) truncated = true
  }
  if (previousMessagesNearestFirst.length < previousRowsDescending.length) truncated = true

  return renderReadPayload(
    mailbox,
    requestedContextBefore,
    requestedLimit,
    reversedCopy(previousMessagesNearestFirst),
    messages,
    truncated,
  )
}

function projectMessage(
  row: InboxMessageRow,
  selfExternalIds: Partial<Record<ChatPlatform, string>>,
): { value: Record<string, unknown>; textTruncated: boolean } {
  const conversation = conversationForRow(row)
  const mentionTargets = extractMentionTargets(row.content)
  const resolved = row.resolvedText ?? row.searchText
  const rawText = row.eventKind === 'recall'
    ? `[消息已撤回: ${row.messageExternalId}]`
    : row.eventKind === 'edit'
      ? `[消息已编辑: ${row.messageExternalId}]${resolved ? `\n${resolved}` : ''}`
      : resolved
  const textTruncated = rawText.length > MESSAGE_TEXT_CAP_CHARS
  const text = textTruncated
    ? `${rawText.slice(0, MESSAGE_TEXT_CAP_CHARS)}…`
    : rawText
  return {
    value: {
      rowId: row.rowId,
      mailbox: mailboxKeyForRow(row),
      eventKind: row.eventKind,
      conversation,
      messageExternalId: row.messageExternalId,
      replyToExternalId: row.replyToExternalId ?? null,
      rootExternalId: row.rootExternalId ?? null,
      threadExternalId: row.threadExternalId ?? null,
      sentAt: formatBeijingMinuteIso(row.sentAt ?? row.createdAt),
      senderExternalId: row.senderExternalId,
      senderName: row.senderConversationName ?? row.senderName ?? row.senderExternalId,
      replyable: row.eventKind !== 'recall',
      mentionedSelf: mentionTargets.includes(selfExternalIds[conversation.platform] ?? ''),
      mentionTargets,
      text,
      media: extractMediaHandles(row.content),
    },
    textTruncated,
  }
}

function renderReadPayload(
  mailbox: string,
  requestedContextBefore: number,
  requestedLimit: number,
  previousMessages: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  truncated: boolean,
): string {
  return JSON.stringify({
    ok: true,
    mailbox,
    requestedLimit,
    truncated,
    ...(requestedContextBefore > 0
      ? { requestedContextBefore, previousMessages }
      : {}),
    messages,
  }, null, 2)
}

function reversedCopy<T>(values: readonly T[]): T[] {
  return [...values].reverse()
}

interface InboxMediaHandle {
  type: string
  mediaId: number
  fileName?: string
  fileSize?: string
}

function extractMediaHandles(content: unknown): InboxMediaHandle[] {
  const media: InboxMediaHandle[] = []
  const visit = (segments: unknown): void => {
    if (!Array.isArray(segments)) return
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue
      const value = segment as Record<string, unknown>
      if (value.type === 'forward' && Array.isArray(value.items)) {
        for (const item of value.items) {
          if (!item || typeof item !== 'object') continue
          visit((item as Record<string, unknown>).content)
        }
        continue
      }
      if (typeof value.type !== 'string' || !MEDIA_SEGMENT_TYPES.has(value.type)) continue
      if (typeof value.referenceId !== 'string') continue
      const mediaId = Number(value.referenceId)
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0) continue
      media.push({
        type: value.type,
        mediaId,
        ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
        ...(typeof value.fileSize === 'string' ? { fileSize: value.fileSize } : {}),
      })
    }
  }
  visit(content)
  return media
}

function extractMentionTargets(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const targets: string[] = []
  const seen = new Set<string>()
  for (const segment of content) {
    if (!segment || typeof segment !== 'object') continue
    const value = segment as Record<string, unknown>
    if (value.type !== 'at' || typeof value.targetId !== 'string') continue
    if (seen.has(value.targetId)) continue
    seen.add(value.targetId)
    targets.push(value.targetId)
  }
  return targets
}

function errorResult(error: string) {
  return {
    content: JSON.stringify({ ok: false, error }),
    outcome: { ok: false as const, code: 'invalid_source', error, progress: false, continuation: 'immediate' as const },
  }
}

async function defaultFindMessages(args: InboxFindManyArgs): Promise<InboxMessageRow[]> {
  return prisma.message.findMany(args as never) as unknown as Promise<InboxMessageRow[]>
}
