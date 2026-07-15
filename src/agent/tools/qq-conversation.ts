import { z } from 'zod'
import type { QqConversationFocus } from '../agent-context.types.js'
import type { Tool } from '../tool.js'
import type { QqDirectoryFriend, QqDirectoryGroup } from './qq-directory.js'

type ActiveQqConversationFocus = Exclude<QqConversationFocus, null>

const targetSchema = z.union([
  z.object({
    type: z.literal('group'),
    groupId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('private'),
    userId: z.number().int().positive(),
  }),
])

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('current') }),
  z.object({
    action: z.literal('open'),
    target: targetSchema,
  }),
  z.object({ action: z.literal('close') }),
])

type Args = z.infer<typeof argsSchema>

export interface QqConversationFocusState {
  get(): QqConversationFocus
  set(focus: QqConversationFocus): void
}

export interface ConversationSummary {
  target: ActiveQqConversationFocus
  displayName: string
}

export type OpenResult =
  | { ok: true; current: ActiveQqConversationFocus }
  | { ok: false; code: 'CHAT_TARGET_UNAVAILABLE'; current: QqConversationFocus }

export interface QqConversationController {
  getCurrent(): QqConversationFocus
  resolveCurrent(): Promise<
    | { ok: true; target: ActiveQqConversationFocus }
    | { ok: false; code: 'CHAT_CONTEXT_UNAVAILABLE' | 'CHAT_CONTEXT_STALE' }
  >
  open(target: ActiveQqConversationFocus): Promise<OpenResult>
  close(): void
  list(): Promise<ConversationSummary[]>
}

interface QqConversationControllerDeps {
  state: QqConversationFocusState
  groupIds: readonly number[]
  loadGroups: () => Promise<readonly QqDirectoryGroup[]>
  loadFriends: () => Promise<readonly QqDirectoryFriend[]>
}

export function createQqConversationController(
  deps: QqConversationControllerDeps,
): QqConversationController {
  const monitoredGroupIds = new Set(deps.groupIds)

  async function isAvailable(target: ActiveQqConversationFocus): Promise<boolean> {
    if (target.type === 'group') {
      if (!monitoredGroupIds.has(target.groupId)) return false
      const groups = await deps.loadGroups()
      return groups.some((group) => group.groupId === target.groupId)
    }
    const friends = await deps.loadFriends()
    return friends.some((friend) => friend.userId === target.userId)
  }

  return {
    getCurrent() {
      return cloneFocus(deps.state.get())
    },
    async resolveCurrent() {
      const current = deps.state.get()
      if (current == null) {
        return { ok: false, code: 'CHAT_CONTEXT_UNAVAILABLE' }
      }
      if (!await isAvailable(current)) {
        deps.state.set(null)
        return { ok: false, code: 'CHAT_CONTEXT_STALE' }
      }
      return { ok: true, target: cloneActiveFocus(current) }
    },
    async open(target) {
      if (!await isAvailable(target)) {
        return {
          ok: false,
          code: 'CHAT_TARGET_UNAVAILABLE',
          current: cloneFocus(deps.state.get()),
        }
      }
      const current = cloneActiveFocus(target)
      deps.state.set(current)
      return { ok: true, current: cloneActiveFocus(current) }
    },
    close() {
      deps.state.set(null)
    },
    async list() {
      const [groups, friends] = await Promise.all([deps.loadGroups(), deps.loadFriends()])
      const groupConversations = groups
        .filter((group) => monitoredGroupIds.has(group.groupId))
        .sort((a, b) => a.groupId - b.groupId)
        .map((group): ConversationSummary => ({
          target: { type: 'group', groupId: group.groupId },
          displayName: firstNonEmpty(group.groupRemark, group.groupName) ?? String(group.groupId),
        }))
      const privateConversations = friends
        .slice()
        .sort((a, b) => a.userId - b.userId)
        .map((friend): ConversationSummary => ({
          target: { type: 'private', userId: friend.userId },
          displayName: firstNonEmpty(friend.remark, friend.nickname) ?? String(friend.userId),
        }))
      return [...groupConversations, ...privateConversations]
    },
  }
}

export function createQqConversationTool(controller: QqConversationController): Tool<Args> {
  return {
    name: 'qq_conversation',
    description: [
      '管理当前 QQ 会话焦点。',
      'list 列出当前可打开的监听群和好友；current 查看当前会话；open 显式打开一个会话；close 清除当前会话。',
      '发送前先确认或打开正确会话，不能从消息文本、memory 或日志推断 target。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'list') {
        return {
          content: JSON.stringify({
            ok: true,
            action: args.action,
            current: controller.getCurrent(),
            conversations: await controller.list(),
          }),
        }
      }
      if (args.action === 'current') {
        return {
          content: JSON.stringify({
            ok: true,
            action: args.action,
            current: controller.getCurrent(),
          }),
        }
      }
      if (args.action === 'close') {
        controller.close()
        return {
          content: JSON.stringify({
            ok: true,
            action: args.action,
            current: null,
          }),
        }
      }

      const result = await controller.open(args.target)
      return {
        content: JSON.stringify({
          ...result,
          action: args.action,
        }),
      }
    },
  }
}

function cloneFocus(focus: QqConversationFocus): QqConversationFocus {
  return focus == null ? null : cloneActiveFocus(focus)
}

function cloneActiveFocus(focus: ActiveQqConversationFocus): ActiveQqConversationFocus {
  return focus.type === 'group'
    ? { type: 'group', groupId: focus.groupId }
    : { type: 'private', userId: focus.userId }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  return null
}
