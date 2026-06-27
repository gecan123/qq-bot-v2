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
    next: activeItem
      ? `Continue todo "${activeItem.id}" or update the list when status changes.`
      : 'No active todo. Set one item to in_progress before starting multi-step work.',
  }
}

export function createTodoTool(): Tool<Args> {
  let items: TodoItem[] = []

  return {
    name: 'todo',
    description: [
      '轻量计划工具, 用来管理当前进程内的多步任务清单.',
      'action=update: 提交完整 todo 列表; 同一时间最多一个 item.status=in_progress.',
      'action=list: 查看当前列表.',
      '适合复杂或多步工作; 长期/跨重启任务以后走持久 task system, 不要把 todo 当长期记忆.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'list') {
        return { content: JSON.stringify(renderState(items)) }
      }

      const activeCount = args.items.filter((item) => item.status === 'in_progress').length
      if (activeCount > 1) {
        return {
          content: JSON.stringify({
            ok: false,
            error: 'Only one todo item can be in_progress',
            items,
          }),
        }
      }

      items = args.items.map((item) => ({ ...item }))
      return { content: JSON.stringify(renderState(items)) }
    },
  }
}

export const todoTool = createTodoTool()
