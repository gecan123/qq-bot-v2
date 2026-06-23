import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import { createCheckTasksTool } from './check-tasks.js'
import { createGetTaskResultTool } from './get-task-result.js'

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('查看后台任务状态列表.'),
  }),
  z.object({
    action: z.literal('get').describe('获取已完成后台任务的详细结果.'),
    taskId: z.string().min(1).describe('要查看结果的后台任务 ID.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface BackgroundTaskToolDeps {
  taskRegistry: BackgroundTaskRegistry
}

export function createBackgroundTaskTool(deps: BackgroundTaskToolDeps): Tool<Args> {
  const checkTasks = createCheckTasksTool(deps)
  const getTaskResult = createGetTaskResultTool(deps)

  return {
    name: 'background_task',
    description: [
      '通用后台任务状态/结果工具, 一个入口用 action 决定动作.',
      'action=list: 查看所有异步工具创建的正在运行和最近完成/失败的任务.',
      'action=get: 读取某个已完成任务的详细结果; 图片生成任务会返回预览图和 ephemeralRef.',
      '任何工具返回 taskId 或收到 [后台任务完成] 后, 都用这里查看状态或取结果; 不负责创建任务.',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      if (args.action === 'list') return await checkTasks.execute({}, ctx)
      return await getTaskResult.execute({ taskId: args.taskId }, ctx)
    },
  }
}
