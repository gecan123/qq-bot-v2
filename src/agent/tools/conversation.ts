import { z } from 'zod'
import type { ConversationRef } from '../../chat/conversation.js'
import { conversationKey } from '../../chat/conversation.js'
import type { Tool } from '../tool.js'
import { createToolResultProgressTracker } from '../tool-progress.js'

const targetSchema = z.object({
  platform: z.enum(['qq', 'feishu']),
  accountId: z.string().min(1),
  kind: z.enum(['group', 'private']),
  externalId: z.string().min(1),
})

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('current') }),
  z.object({ action: z.literal('open'), target: targetSchema }),
  z.object({ action: z.literal('close') }),
])

type Args = z.infer<typeof argsSchema>

export interface ConversationFocusState {
  get(): ConversationRef | null
  set(focus: ConversationRef | null): void
}

export interface ConversationSummary {
  target: ConversationRef
  displayName: string
}

export type OpenConversationResult =
  | { ok: true; current: ConversationRef }
  | { ok: false; code: 'CHAT_TARGET_UNAVAILABLE'; current: ConversationRef | null }

export interface ConversationController {
  getCurrent(): ConversationRef | null
  resolveCurrent(): Promise<
    | { ok: true; target: ConversationRef }
    | { ok: false; code: 'CHAT_CONTEXT_UNAVAILABLE' | 'CHAT_CONTEXT_STALE' }
  >
  open(target: ConversationRef): Promise<OpenConversationResult>
  close(): void
  list(): Promise<ConversationSummary[]>
}

export function createConversationController(input: {
  state: ConversationFocusState
  loadConversations: () => Promise<readonly ConversationSummary[]>
}): ConversationController {
  async function availableConversations(): Promise<ConversationSummary[]> {
    return (await input.loadConversations()).map((conversation) => ({
      target: cloneConversation(conversation.target),
      displayName: conversation.displayName,
    }))
  }

  async function isAvailable(target: ConversationRef): Promise<boolean> {
    const key = conversationKey(target)
    return (await availableConversations()).some((item) => conversationKey(item.target) === key)
  }

  return {
    getCurrent: () => cloneNullableConversation(input.state.get()),
    async resolveCurrent() {
      const current = input.state.get()
      if (!current) return { ok: false, code: 'CHAT_CONTEXT_UNAVAILABLE' }
      if (!await isAvailable(current)) {
        input.state.set(null)
        return { ok: false, code: 'CHAT_CONTEXT_STALE' }
      }
      return { ok: true, target: cloneConversation(current) }
    },
    async open(target) {
      if (!await isAvailable(target)) {
        return {
          ok: false,
          code: 'CHAT_TARGET_UNAVAILABLE',
          current: cloneNullableConversation(input.state.get()),
        }
      }
      const current = cloneConversation(target)
      input.state.set(current)
      return { ok: true, current: cloneConversation(current) }
    },
    close() {
      input.state.set(null)
    },
    list: availableConversations,
  }
}

export function createConversationTool(controller: ConversationController): Tool<Args> {
  const progress = createToolResultProgressTracker()
  return {
    name: 'conversation',
    description: [
      '管理当前 QQ / 飞书会话焦点。',
      'list 列出允许打开的会话；current 查看当前会话；open 显式打开；close 只清除会话焦点并结束当前方向，不停止 Runtime。',
      '发送前必须先确认或打开正确会话；新入站消息不会隐式切换 target。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'list') {
        const conversations = await controller.list()
        return observed(progress, 'list', {
          ok: true,
          action: args.action,
          current: controller.getCurrent(),
          conversations: conversations.map((item) => ({
            ...item,
            key: conversationKey(item.target),
          })),
        })
      }
      if (args.action === 'current') {
        return observed(progress, 'current', {
          ok: true,
          action: args.action,
          current: controller.getCurrent(),
        })
      }
      if (args.action === 'close') {
        const changed = controller.getCurrent() != null
        controller.close()
        return {
          content: JSON.stringify({ ok: true, action: args.action, current: null }),
          outcome: {
            ok: true,
            code: changed ? 'closed' : 'unchanged',
            progress: false,
            continuation: 'wait_attention',
          },
        }
      }

      const previous = controller.getCurrent()
      const result = await controller.open(args.target)
      const changed = result.ok
        && (previous == null || conversationKey(previous) !== conversationKey(result.current))
      return {
        content: JSON.stringify({ ...result, action: args.action }),
        outcome: result.ok
          ? {
              ok: true,
              code: changed ? 'opened' : 'unchanged',
              progress: false,
              continuation: 'immediate',
            }
          : {
              ok: false,
              code: result.code,
              progress: false,
              continuation: 'immediate',
            },
      }
    },
  }
}

function observed(
  progress: ReturnType<typeof createToolResultProgressTracker>,
  key: string,
  payload: Record<string, unknown>,
) {
  const content = JSON.stringify(payload)
  const changed = progress.observe(key, content)
  return {
    content,
    outcome: { ok: true as const, code: changed ? 'observed' : 'unchanged', progress: changed },
  }
}

function cloneConversation(target: ConversationRef): ConversationRef {
  return { ...target }
}

function cloneNullableConversation(target: ConversationRef | null): ConversationRef | null {
  return target ? cloneConversation(target) : null
}
