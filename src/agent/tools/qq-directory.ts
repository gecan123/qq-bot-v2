import { z } from 'zod'
import type { Tool } from '../tool.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_LABEL_CHARS = 100

const argsSchema = z.object({
  action: z.enum(['list_friends', 'search_friends', 'list_groups', 'profile']).describe(
    '目录操作. search_friends 时 query 必填; profile 时 userId 必填; 其余动作不使用它们.',
  ),
  query: z.string().trim().min(1).max(100).optional().describe(
    'action=search_friends 时必填; 按 QQ 号、昵称或备注做不区分大小写的包含匹配.',
  ),
  offset: z.number().int().min(0).optional().describe('分页偏移, 默认 0.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('返回条数, 默认 20, 最大 50.'),
  userId: z.number().int().positive().safe().optional().describe('action=profile 时必填的 QQ 号.'),
}).superRefine((value, ctx) => {
  if (value.action === 'search_friends' && !value.query) {
    ctx.addIssue({ code: 'custom', path: ['query'], message: 'query is required for search_friends' })
  }
  if (value.action === 'profile' && value.userId == null) {
    ctx.addIssue({ code: 'custom', path: ['userId'], message: 'userId is required for profile' })
  }
})

type Args = z.infer<typeof argsSchema>

export interface QqDirectoryFriend {
  userId: number
  nickname: string
  remark?: string | null
}

export interface QqDirectoryGroup {
  groupId: number
  groupName: string
  groupRemark?: string | null
  memberCount?: number | null
  maxMemberCount?: number | null
}

export interface QqObservedIdentityRow {
  rowId: number
  senderNickname: string | null
  senderGroupNickname: string | null
  groupId: number | null
  groupName: string | null
  seenAt: Date
}

export interface QqDirectoryDeps {
  groupIds: readonly number[]
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
  loadObservedIdentity?: (userId: number, limit: number) => Promise<readonly QqObservedIdentityRow[]>
}

export function createQqDirectoryTool(deps: QqDirectoryDeps): Tool<Args> {
  const monitoredGroupIds = new Set(deps.groupIds)
  const progress = createToolResultProgressTracker()

  return {
    name: 'qq_directory',
    description: [
      '只读查看当前 QQ 可聊天对象.',
      'list_friends 分页列出全部当前好友; search_friends 按 QQ 号、昵称或备注搜索好友.',
      'list_groups 只返回 BOT_TARGET_GROUP_IDS 已配置且当前账号确实加入的群; 未配置群不会披露也不能聊天.',
      'profile 按 QQ 号合并当前好友资料和 messages 事实账本里的历史昵称/群昵称；用它核对“这个昵称是谁”，不要靠语义记忆猜身份.',
      '目录结果中的 userId/groupId 可作为 send_message 的明确 target.',
      '本工具不能添加或删除好友, 也不能加入、退出或管理群聊.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'profile') {
          const userId = args.userId!
          const [friends, observed] = await Promise.all([
            deps.loadFriends(),
            deps.loadObservedIdentity?.(userId, 200) ?? Promise.resolve([]),
          ])
          const current = friends.find((friend) => friend.userId === userId) ?? null
          const payload = profileResult(userId, current, observed, monitoredGroupIds)
          const content = JSON.stringify(payload, null, 2)
          const changed = progress.observe(`profile:${userId}`, content)
          return {
            content,
            outcome: { ok: true, code: changed ? 'observed' : 'unchanged', progress: changed },
          }
        }

        if (args.action === 'list_groups') {
          const groups = (await deps.loadGroups())
            .filter((group) => monitoredGroupIds.has(group.groupId))
            .map((group) => ({
              groupId: group.groupId,
              groupName: nonEmpty(group.groupName) ?? String(group.groupId),
              groupRemark: nonEmpty(group.groupRemark),
              memberCount: group.memberCount ?? null,
              maxMemberCount: group.maxMemberCount ?? null,
            }))
          return observedResult(progress, `list_groups:${args.offset ?? 0}:${args.limit ?? DEFAULT_LIMIT}`, pageResult(args.action, groups, args.offset, args.limit))
        }

        const friends = (await deps.loadFriends()).map((friend) => ({
          userId: friend.userId,
          nickname: nonEmpty(friend.nickname) ?? String(friend.userId),
          remark: nonEmpty(friend.remark),
          displayName: nonEmpty(friend.remark) ?? nonEmpty(friend.nickname) ?? String(friend.userId),
        }))
        const query = args.action === 'search_friends' ? args.query?.trim().toLocaleLowerCase() : undefined
        const filtered = query
          ? friends.filter((friend) => [
              String(friend.userId),
              friend.nickname,
              friend.remark ?? '',
            ].some((value) => value.toLocaleLowerCase().includes(query)))
          : friends
        return observedResult(
          progress,
          `${args.action}:${query ?? ''}:${args.offset ?? 0}:${args.limit ?? DEFAULT_LIMIT}`,
          pageResult(args.action, filtered, args.offset, args.limit, query),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: JSON.stringify({
            ok: false,
            action: args.action,
            error: `QQ directory unavailable: ${message}`,
          }),
          outcome: {
            ok: false,
            code: 'directory_unavailable',
            error: `QQ directory unavailable: ${message}`,
            progress: false,
            retryClass: 'backoff',
          },
        }
      }
    },
  }
}

function observedResult(
  tracker: ReturnType<typeof createToolResultProgressTracker>,
  key: string,
  payload: Record<string, unknown>,
) {
  const content = JSON.stringify(payload, null, 2)
  const changed = tracker.observe(key, content)
  return {
    content,
    outcome: { ok: true as const, code: changed ? 'observed' : 'unchanged', progress: changed },
  }
}

function profileResult(
  userId: number,
  current: QqDirectoryFriend | null,
  observed: readonly QqObservedIdentityRow[],
  monitoredGroupIds: ReadonlySet<number>,
): Record<string, unknown> {
  const aliases: Array<{
    value: string
    source: 'friend_remark' | 'friend_nickname' | 'group_nickname' | 'sender_nickname'
    lastSeenRowId: number | null
    lastSeenAt: string | null
  }> = []
  const seenAliases = new Set<string>()
  const addAlias = (
    value: string | null | undefined,
    source: typeof aliases[number]['source'],
    row?: QqObservedIdentityRow,
  ) => {
    const normalized = nonEmpty(value)
    if (!normalized || seenAliases.has(normalized)) return
    seenAliases.add(normalized)
    aliases.push({
      value: normalized,
      source,
      lastSeenRowId: row?.rowId ?? null,
      lastSeenAt: row ? formatBeijingIso(row.seenAt) : null,
    })
  }
  addAlias(current?.remark, 'friend_remark')
  addAlias(current?.nickname, 'friend_nickname')
  for (const row of observed) {
    if (row.groupId != null && monitoredGroupIds.has(row.groupId)) {
      addAlias(row.senderGroupNickname, 'group_nickname', row)
    }
    addAlias(row.senderNickname, 'sender_nickname', row)
  }

  const groups = new Map<number, {
    groupId: number
    groupName: string
    aliases: string[]
    lastSeenRowId: number
    lastSeenAt: string
  }>()
  for (const row of observed) {
    if (row.groupId == null || !monitoredGroupIds.has(row.groupId)) continue
    const aliasValues = [nonEmpty(row.senderGroupNickname), nonEmpty(row.senderNickname)]
      .filter((value): value is string => value != null)
    const existing = groups.get(row.groupId)
    if (!existing) {
      groups.set(row.groupId, {
        groupId: row.groupId,
        groupName: nonEmpty(row.groupName) ?? String(row.groupId),
        aliases: [...new Set(aliasValues)],
        lastSeenRowId: row.rowId,
        lastSeenAt: formatBeijingIso(row.seenAt),
      })
      continue
    }
    existing.aliases = [...new Set([...existing.aliases, ...aliasValues])]
  }

  return {
    ok: true,
    userId,
    currentFriend: current
      ? {
          nickname: nonEmpty(current.nickname) ?? String(userId),
          remark: nonEmpty(current.remark),
          displayName: nonEmpty(current.remark) ?? nonEmpty(current.nickname) ?? String(userId),
        }
      : null,
    aliases,
    groups: [...groups.values()].sort((left, right) => right.lastSeenRowId - left.lastSeenRowId),
  }
}

function pageResult<T>(
  action: Args['action'],
  items: readonly T[],
  requestedOffset?: number,
  requestedLimit?: number,
  query?: string,
): Record<string, unknown> {
  const offset = Math.min(requestedOffset ?? 0, items.length)
  const limit = requestedLimit ?? DEFAULT_LIMIT
  const page = items.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    ok: true,
    action,
    ...(query ? { query } : {}),
    total: items.length,
    offset,
    limit,
    hasMore: nextOffset < items.length,
    nextOffset: nextOffset < items.length ? nextOffset : null,
    items: page,
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, MAX_LABEL_CHARS) : null
}
