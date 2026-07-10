import { z } from 'zod'
import { prisma } from '../../database/client.js'
import type { Tool } from '../tool.js'

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 50
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
  findMessages?: (args: InboxFindManyArgs) => Promise<InboxMessageRow[]>
}

export function createInboxTool(deps: InboxToolDeps): Tool<Args> {
  const monitoredGroups = new Set(deps.groupIds)
  const selfNumber = String(deps.selfNumber)
  const findMessages = deps.findMessages ?? defaultFindMessages

  return {
    name: 'inbox',
    description: [
      '按需查看没有自动进入上下文的 QQ mailbox.',
      'action=list 列出最近有消息的来源; action=read 读取一个明确群或私聊来源.',
      '群来源必须在监听白名单内. read 结果按 messages rowId 升序, 用 afterRowId 继续分页.',
      'inbox 更新通知只是元数据; 需要理解或引用正文时再调用本工具.',
      'read 结果中的 media 数组提供图片等媒体的 mediaId, 可直接用于 collect_sticker 等接受 image handle 的工具.',
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
        const mailboxes: Array<{ mailbox: string; label: string; latestRowId: number }> = []
        for (const row of rows) {
          const mailbox = mailboxKeyForRow(row)
          if (seen.has(mailbox)) continue
          seen.add(mailbox)
          mailboxes.push({
            mailbox,
            label: row.sceneKind === 'qq_group'
              ? row.groupName ?? String(row.groupId)
              : row.senderNickname ?? row.sceneExternalId,
            latestRowId: row.id,
          })
        }
        return { content: JSON.stringify({ ok: true, mailboxes }, null, 2) }
      }

      const afterRowId = args.afterRowId ?? 0
      const limit = args.limit ?? DEFAULT_READ_LIMIT
      let mailbox: string
      let where: Record<string, unknown>
      if (args.source === 'group') {
        if (args.groupId == null) return errorResult('source=group requires groupId')
        if (!monitoredGroups.has(args.groupId)) {
          return errorResult(`groupId=${args.groupId} is not monitored`)
        }
        mailbox = `qq_group:${args.groupId}`
        where = {
          sceneKind: 'qq_group',
          groupId: BigInt(args.groupId),
          id: { gt: afterRowId },
        }
      } else {
        if (args.peerId == null) return errorResult('source=private requires peerId')
        mailbox = `qq_private:${args.peerId}`
        where = {
          sceneKind: 'qq_private',
          sceneExternalId: String(args.peerId),
          id: { gt: afterRowId },
        }
      }

      const rows = await findMessages({ where, orderBy: { id: 'asc' }, take: limit })
      return { content: renderBoundedRead(mailbox, rows, limit, selfNumber) }
    },
  }
}

function mailboxKeyForRow(row: InboxMessageRow): string {
  return row.sceneKind === 'qq_private'
    ? `qq_private:${row.sceneExternalId}`
    : `qq_group:${String(row.groupId)}`
}

function renderBoundedRead(
  mailbox: string,
  rows: readonly InboxMessageRow[],
  requestedLimit: number,
  selfNumber: string,
): string {
  const messages: Array<Record<string, unknown>> = []
  let truncated = false
  for (const row of rows) {
    const mentionTargets = extractMentionTargets(row.content)
    const rawText = row.resolvedText ?? row.searchText
    const text = rawText.length > MESSAGE_TEXT_CAP_CHARS
      ? `${rawText.slice(0, MESSAGE_TEXT_CAP_CHARS)}…`
      : rawText
    const projected = {
      rowId: row.id,
      mailbox: mailboxKeyForRow(row),
      messageId: String(row.messageId),
      sentAt: (row.sentAt ?? row.createdAt).toISOString(),
      senderId: String(row.senderId),
      senderName: row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId),
      mentionedSelf: mentionTargets.includes(selfNumber),
      mentionTargets,
      text,
      media: extractMediaHandles(row.content),
    }
    const candidate = JSON.stringify({ ok: true, mailbox, requestedLimit, truncated: false, messages: [...messages, projected] }, null, 2)
    if (candidate.length > INBOX_OUTPUT_CAP_CHARS) {
      truncated = true
      break
    }
    messages.push(projected)
    if (rawText.length > MESSAGE_TEXT_CAP_CHARS) truncated = true
  }
  if (messages.length < rows.length) truncated = true
  return JSON.stringify({ ok: true, mailbox, requestedLimit, truncated, messages }, null, 2)
}

function extractMediaHandles(content: unknown): Array<{ type: string; mediaId: number }> {
  const media: Array<{ type: string; mediaId: number }> = []
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
      media.push({ type: value.type, mediaId })
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

function errorResult(error: string): { content: string } {
  return { content: JSON.stringify({ ok: false, error }) }
}

async function defaultFindMessages(args: InboxFindManyArgs): Promise<InboxMessageRow[]> {
  return prisma.message.findMany(args as never) as unknown as Promise<InboxMessageRow[]>
}
