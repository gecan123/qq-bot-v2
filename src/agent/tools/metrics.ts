import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { DailyAgentMetricsOptions } from '../../ops/agent-daily-metrics.js'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('today') }),
  z.object({ action: z.literal('yesterday') }),
  z.object({ action: z.literal('date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal('days'), days: z.number().int().min(1).max(7) }),
])

type Args = z.infer<typeof argsSchema>

export interface MetricsToolDeps {
  load?: (options: DailyAgentMetricsOptions) => Promise<unknown>
}

export function createMetricsTool(deps: MetricsToolDeps = {}): Tool<Args> {
  const load = deps.load ?? (async (options) => {
    const { loadDailyAgentMetrics } = await import('../../ops/agent-daily-metrics.js')
    return await loadDailyAgentMetrics(options)
  })
  return {
    name: 'metrics',
    description: '按北京时间自然日读取 Bot 的 token/cache、工具调用和休息指标；默认排除测试模型。使用固定 action，不接受命令行。',
    schema: argsSchema,
    async execute(args) {
      const options: DailyAgentMetricsOptions = args.action === 'yesterday'
        ? { endOffsetDays: -1 }
        : args.action === 'date'
          ? { date: args.date }
          : args.action === 'days'
            ? { days: args.days }
            : {}
      const report = await load(options)
      return { content: renderMetricsResult(report), outcome: { ok: true, progress: true } }
    },
  }
}

function renderMetricsResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return JSON.stringify({ ok: true, reports: [] })
  }
  const raw = result as Record<string, unknown>
  const reports = Array.isArray(raw.reports)
    ? raw.reports.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const report = value as Record<string, unknown>
      const tokenUsage = report.tokenUsage && typeof report.tokenUsage === 'object' && !Array.isArray(report.tokenUsage)
        ? (report.tokenUsage as Record<string, unknown>).total
        : undefined
      return { date: report.date, tokenUsage, toolCalls: report.toolCalls, rest: report.rest }
    })
    : []
  return JSON.stringify({
    ok: true,
    timezone: raw.timezone,
    generatedAt: raw.generatedAt,
    excludedModels: raw.excludedModels,
    reports,
  })
}
