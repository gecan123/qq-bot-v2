import { z } from 'zod'
import type { Tool } from '../tool.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_LABEL_CHARS = 100

const argsSchema = z.object({
  action: z.enum(['list_friends', 'search_friends', 'list_groups']).describe(
    '目录操作. action=search_friends 时 query 必填; list_friends/list_groups 不使用 query.',
  ),
  query: z.string().trim().min(1).max(100).optional().describe(
    'action=search_friends 时必填; 按 QQ 号、昵称或备注做不区分大小写的包含匹配.',
  ),
  offset: z.number().int().min(0).optional().describe('分页偏移, 默认 0.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('返回条数, 默认 20, 最大 50.'),
}).superRefine((value, ctx) => {
  if (value.action === 'search_friends' && !value.query) {
    ctx.addIssue({ code: 'custom', path: ['query'], message: 'query is required for search_friends' })
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

export interface QqDirectoryDeps {
  groupIds: readonly number[]
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
}

export function createQqDirectoryTool(deps: QqDirectoryDeps): Tool<Args> {
  const monitoredGroupIds = new Set(deps.groupIds)

  return {
    name: 'qq_directory',
    description: [
      '只读查看当前 QQ 可聊天对象.',
      'list_friends 分页列出全部当前好友; search_friends 按 QQ 号、昵称或备注搜索好友.',
      'list_groups 只返回 BOT_TARGET_GROUP_IDS 已配置且当前账号确实加入的群; 未配置群不会披露也不能聊天.',
      '目录结果中的 userId/groupId 可作为 send_message 的明确 target.',
      '本工具不能添加或删除好友, 也不能加入、退出或管理群聊.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
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
          return { content: JSON.stringify(pageResult(args.action, groups, args.offset, args.limit), null, 2) }
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
        return { content: JSON.stringify(pageResult(args.action, filtered, args.offset, args.limit, query), null, 2) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: JSON.stringify({
            ok: false,
            action: args.action,
            error: `QQ directory unavailable: ${message}`,
          }),
        }
      }
    },
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
