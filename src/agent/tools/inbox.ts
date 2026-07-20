import { z } from 'zod'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'
import type { Tool } from '../tool.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import type { InboxReadCursors } from '../inbox-read-cursors.js'

const log = createLogger('INBOX')

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 50
const MAX_CONTEXT_BEFORE = 8
const LIST_SCAN_LIMIT = 500
const MESSAGE_TEXT_CAP_CHARS = 2_000
export const INBOX_OUTPUT_CAP_CHARS = 12_000
const MEDIA_SEGMENT_TYPES = new Set(['image', 'video', 'record', 'file'])

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('列出当前允许访问且最近有消息的 mailbox.'),
  }),
  z.object({
    action: z.literal('read').describe('按明确来源读取消息正文.'),
    source: z.enum(['group', 'private']).describe('来源类型.'),
    groupId: z.number().int().positive().optional().describe('source=group 时必填的监听群号.'),
    peerId: z.number().int().positive().optional().describe('source=private 时必填的好友 QQ.'),
    afterRowId: z.number().int().nonnegative().optional().describe('只返回 messages.id 大于此值的消息.'),
    contextBefore: z.number().int().min(1).max(MAX_CONTEXT_BEFORE).optional()
      .describe('按通知补偿同一 mailbox 在 afterRowId 之前最近的消息, 最大 8 条.'),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional().describe('返回条数, 默认 20, 最大 50.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface InboxMessageRow {
  id: number
  sceneKind: string
  sceneExternalId: string
  groupId: bigint | null
  groupName: string | null
  messageId: bigint
  senderId: bigint
  senderNickname: string | null
  senderGroupNickname: string | null
  content: unknown
  resolvedText: string | null
  searchText: string
  sentAt: Date | null
  createdAt: Date
}

interface InboxFindManyArgs {
  where: Record<string, unknown>
  orderBy: { id: 'asc' | 'desc' }
  take: number
}

export interface InboxToolDeps {
  groupIds: readonly number[]
  selfNumber: number
  getReadCursors?: () => Readonly<InboxReadCursors>
  findMessages?: (args: InboxFindManyArgs) => Promise<InboxMessageRow[]>
}

export function createInboxTool(deps: InboxToolDeps): Tool<Args> {
  const monitoredGroups = new Set(deps.groupIds)
  const selfNumber = String(deps.selfNumber)
  const findMessages = deps.findMessages ?? defaultFindMessages
  const getReadCursors: () => Readonly<InboxReadCursors> = deps.getReadCursors ?? (() => ({}))
  const progress = createToolResultProgressTracker()

  return {
    name: 'inbox',
    description: [
      '按需查看没有自动进入上下文的 QQ mailbox.',
      'action=list 列出最近有消息的来源; action=read 读取一个明确群或私聊来源.',
      '群来源必须在监听白名单内. read 结果按 messages rowId 升序, 用 afterRowId 继续分页.',
      '通知中的 readArgs 可能带 contextBefore, 此时 previousMessages 是 runtime 为长间隔或远距离上下文自动补偿的同 mailbox 前置消息.',
      'inbox 更新通知只是元数据; 需要理解或引用正文时再调用本工具.',
      'read 结果中的 media 数组提供媒体的 mediaId、文件名和大小; type=file 时可激活 document_reading 后调用 read_file 查看内容.',
      'read 结果中的 mentionedSelf 和 mentionTargets 来自 QQ 结构化 at 段; 正文里的“你”或“@你”只是普通文本, 不代表在叫你.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'list') {
        const groupIds = [...monitoredGroups].map(BigInt)
        const sourceFilters: Array<Record<string, unknown>> = [{ sceneKind: 'qq_private' }]
        if (groupIds.length > 0) {
          sourceFilters.unshift({ sceneKind: 'qq_group', groupId: { in: groupIds } })
        }
        const rows = await findMessages({
          where: { OR: sourceFilters },
          orderBy: { id: 'desc' },
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
          if (row.id <= lastReadRowId) continue
          mailboxes.push({
            mailbox,
            label: row.sceneKind === 'qq_group'
              ? row.groupName ?? String(row.groupId)
              : row.senderNickname ?? row.sceneExternalId,
            latestRowId: row.id,
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

      const contextBefore = args.contextBefore ?? 0
      const limit = args.limit ?? DEFAULT_READ_LIMIT
      let mailbox: string
      let sourceWhere: Record<string, unknown>
      if (args.source === 'group') {
        if (args.groupId == null) return errorResult('source=group requires groupId')
        if (!monitoredGroups.has(args.groupId)) {
          return errorResult(`groupId=${args.groupId} is not monitored`)
        }
        mailbox = `qq_group:${args.groupId}`
        sourceWhere = {
          sceneKind: 'qq_group',
          groupId: BigInt(args.groupId),
        }
      } else {
        if (args.peerId == null) return errorResult('source=private requires peerId')
        mailbox = `qq_private:${args.peerId}`
        sourceWhere = {
          sceneKind: 'qq_private',
          sceneExternalId: String(args.peerId),
        }
      }

      const afterRowId = args.afterRowId ?? getReadCursors()[mailbox] ?? 0

      const where = { ...sourceWhere, id: { gt: afterRowId } }
      const rows = await findMessages({ where, orderBy: { id: 'asc' }, take: limit })
      const previousRows = contextBefore > 0 && afterRowId > 0
        ? await findMessages({
            where: { ...sourceWhere, id: { lte: afterRowId } },
            orderBy: { id: 'desc' },
            take: contextBefore,
          })
        : []
      if (args.source === 'group' && args.groupId != null) {
        log.info({
          groupId: args.groupId,
          afterRowId,
          contextBefore,
          requestedLimit: limit,
          returnedMessages: rows.length,
          returnedPreviousMessages: previousRows.length,
        }, 'inbox_group_read_completed')
      }
      const content = renderBoundedRead(mailbox, previousRows, rows, contextBefore, limit, selfNumber)
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
          evidenceMessageRowIds: evidenceRowIdsFromReadPayload(content),
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

function evidenceRowIdsFromReadPayload(content: string): number[] {
  try {
    const parsed = JSON.parse(content) as { messages?: unknown[]; previousMessages?: unknown[] }
    return [...(parsed.previousMessages ?? []), ...(parsed.messages ?? [])]
      .map((value) => value && typeof value === 'object' ? (value as { rowId?: unknown }).rowId : undefined)
      .filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
  } catch {
    return []
  }
}

function mailboxKeyForRow(row: InboxMessageRow): string {
  return row.sceneKind === 'qq_private'
    ? `qq_private:${row.sceneExternalId}`
    : `qq_group:${String(row.groupId)}`
}

function renderBoundedRead(
  mailbox: string,
  previousRowsDescending: readonly InboxMessageRow[],
  rows: readonly InboxMessageRow[],
  requestedContextBefore: number,
  requestedLimit: number,
  selfNumber: string,
): string {
  const messages: Array<Record<string, unknown>> = []
  const previousMessagesNearestFirst: Array<Record<string, unknown>> = []
  let truncated = false
  for (const row of rows) {
    const projected = projectMessage(row, selfNumber)
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
    const projected = projectMessage(row, selfNumber)
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
  selfNumber: string,
): { value: Record<string, unknown>; textTruncated: boolean } {
  const mentionTargets = extractMentionTargets(row.content)
  const rawText = row.resolvedText ?? row.searchText
  const textTruncated = rawText.length > MESSAGE_TEXT_CAP_CHARS
  const text = textTruncated
    ? `${rawText.slice(0, MESSAGE_TEXT_CAP_CHARS)}…`
    : rawText
  return {
    value: {
      rowId: row.id,
      mailbox: mailboxKeyForRow(row),
      messageId: String(row.messageId),
      sentAt: formatBeijingIso(row.sentAt ?? row.createdAt),
      senderId: String(row.senderId),
      senderName: row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId),
      replyable: row.messageId > 0n,
      mentionedSelf: mentionTargets.includes(selfNumber),
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
    outcome: { ok: false as const, code: 'invalid_source', error, progress: false, retryClass: 'immediate' as const },
  }
}

async function defaultFindMessages(args: InboxFindManyArgs): Promise<InboxMessageRow[]> {
  return prisma.message.findMany(args as never) as unknown as Promise<InboxMessageRow[]>
}
