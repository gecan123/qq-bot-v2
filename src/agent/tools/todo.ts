import { z } from 'zod'
import type { Tool } from '../tool.js'

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

const todoItemSchema = z.object({
  id: z.string().trim().min(1).max(64).describe('稳定短 ID, 用来引用这条 todo.'),
  text: z.string().trim().min(1).max(200).describe('要做的事, 一条只写一个动作.'),
  status: todoStatusSchema.describe('当前状态. 同一时间最多一个 in_progress.'),
})

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('查看当前 todo 列表.'),
  }),
  z.object({
    action: z.literal('update').describe('用完整列表替换当前 todo 列表.'),
    items: z.array(todoItemSchema).max(20).describe('完整 todo 列表, 最多 20 条.'),
  }),
])

type Args = z.infer<typeof argsSchema>
type TodoItem = z.infer<typeof todoItemSchema>

function renderState(items: TodoItem[]) {
  const activeItem = items.find((item) => item.status === 'in_progress') ?? null
  return {
    ok: true,
    items,
    activeItem,
    next: items.length === 0
      ? 'Todo list is empty. If there is no concrete multi-step task, end the round without calling todo again.'
      : activeItem
        ? `Continue todo "${activeItem.id}" or update the list when status changes.`
        : 'No todo is in_progress. Start a pending item only when concrete multi-step work remains; otherwise no todo call is needed.',
  }
}

function equalItems(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return other != null
      && item.id === other.id
      && item.text === other.text
      && item.status === other.status
  })
}

export function createTodoTool(): Tool<Args> {
  let items: TodoItem[] = []
  let revision = 0

  return {
    name: 'todo',
    description: [
      '轻量计划工具, 用来管理当前进程内的多步任务清单.',
      'action=update: 提交完整 todo 列表; 同一时间最多一个 item.status=in_progress.',
      'items=[] 只用于清空已有列表; 列表已经为空或没有具体多步任务时不要重复调用.',
      'action=list: 查看当前列表.',
      '适合复杂或多步工作; 长期/跨重启任务以后走持久 task system, 不要把 todo 当长期记忆.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'list') {
        return {
          content: JSON.stringify({ ...renderState(items), revision }),
          outcome: {
            ok: true,
            progress: false,
            continuation: 'immediate',
            noveltyKey: `todo:${revision}`,
          },
        }
      }

      const activeCount = args.items.filter((item) => item.status === 'in_progress').length
      if (activeCount > 1) {
        return {
          content: JSON.stringify({
            ok: false,
            error: 'Only one todo item can be in_progress',
            items,
          }),
          outcome: {
            ok: false,
            code: 'invalid_arguments',
            progress: false,
            retryClass: 'immediate',
            continuation: 'immediate',
          },
        }
      }

      const nextItems = args.items.map((item) => ({ ...item }))
      const changed = !equalItems(items, nextItems)
      items = nextItems
      if (changed) revision++
      const status = changed
        ? items.length === 0 ? 'cleared' : 'updated'
        : 'unchanged'
      return {
        content: JSON.stringify({
          ...renderState(items),
          status,
          changed,
          revision,
        }),
        outcome: {
          ok: true,
          code: status,
          progress: changed,
          continuation: changed ? 'immediate' : 'wait_attention',
          noveltyKey: `todo:${revision}`,
        },
      }
    },
  }
}

export const todoTool = createTodoTool()
