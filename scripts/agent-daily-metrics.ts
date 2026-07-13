import { loadDailyAgentMetrics, type DailyAgentMetricsOptions } from '../src/ops/agent-daily-metrics.js'

const options = parseArgs(process.argv.slice(2))
const result = await loadDailyAgentMetrics(options.metrics)
console.log(JSON.stringify(result, null, options.compact ? 0 : 2))

function parseArgs(argv: string[]): { metrics: DailyAgentMetricsOptions; compact: boolean } {
  const metrics: DailyAgentMetricsOptions = {}
  let compact = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--date') {
      metrics.date = readValue(argv, ++index, arg)
      continue
    }
    if (arg === '--days') {
      metrics.days = Number(readValue(argv, ++index, arg))
      continue
    }
    if (arg === '--token-log') {
      metrics.tokenUsagePath = readValue(argv, ++index, arg)
      continue
    }
    if (arg === '--logs-dir') {
      metrics.logsDir = readValue(argv, ++index, arg)
      continue
    }
    if (arg === '--compact') {
      compact = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: pnpm agent:daily-metrics -- [options]

  --date YYYY-MM-DD  截止自然日，默认北京时间今天
  --days N           连续返回 N 个自然日，包含截止日，范围 1-31
  --token-log PATH   token NDJSON 路径
  --logs-dir PATH    app 滚动日志目录
  --compact          输出单行 JSON`)
      process.exit(0)
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  return { metrics, compact }
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
  return value
}
