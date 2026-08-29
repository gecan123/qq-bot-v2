import { z } from 'zod'
import { formatBeijingMinuteIso } from '../../utils/beijing-time.js'
import type { Tool } from '../tool.js'

const argsSchema = z.object({}).strict()

export function createClockTool(input: {
  now?: () => Date
} = {}): Tool<Record<string, never>> {
  const now = input.now ?? (() => new Date())

  return {
    name: 'clock',
    description: '按需读取当前北京时间（UTC+08:00）；历史消息中的时间只表示事件发生时刻。',
    schema: argsSchema,
    async execute() {
      return {
        content: JSON.stringify({ now: formatBeijingMinuteIso(now()) }),
        outcome: {
          ok: true,
          code: 'time_observed',
          progress: false,
        },
      }
    },
  }
}
