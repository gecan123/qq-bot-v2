import { existsSync, readFileSync } from 'node:fs'
import { summarizeAgentMetrics, type AgentMetricsFilters } from '../src/ops/agent-metrics.js'

type MetricsSource = 'log' | 'db'

interface CliOptions {
  source: MetricsSource
  tokenUsagePath: string
  toolCallsPath: string
  filters: AgentMetricsFilters
}

const options = parseArgs(process.argv.slice(2))
const summary = options.source === 'db'
  ? await summarizeDb(options.filters)
  : summarizeAgentMetrics({
    tokenUsageNdjson: readIfExists(options.tokenUsagePath),
    toolCallsNdjson: readIfExists(options.toolCallsPath),
  }, options.filters)

console.log(JSON.stringify({
  source: options.source,
  ...(options.source === 'log'
    ? {
      tokenUsagePath: options.tokenUsagePath,
      toolCallsPath: options.toolCallsPath,
    }
    : {}),
  ...summary,
}, null, 2))

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

async function summarizeDb(filters: AgentMetricsFilters) {
  const [{ queryPersistedAgentMetrics }, { prisma }] = await Promise.all([
    import('../src/ops/agent-observability-db.js'),
    import('../src/database/client.js'),
  ])
  try {
    return await queryPersistedAgentMetrics(filters)
  } finally {
    await prisma.$disconnect()
  }
}

function parseArgs(argv: string[]): CliOptions {
  let source: MetricsSource = 'log'
  const positional: string[] = []
  const filters: AgentMetricsFilters = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') {
      source = 'db'
      continue
    }
    if (arg === '--source') {
      source = parseSource(readFlagValue(argv, ++i, arg))
      continue
    }
    if (arg === '--from') {
      filters.from = parseDateFlag(readFlagValue(argv, ++i, arg), arg)
      continue
    }
    if (arg === '--to') {
      filters.to = parseDateFlag(readFlagValue(argv, ++i, arg), arg)
      continue
    }
    if (arg === '--tool') {
      filters.toolName = readFlagValue(argv, ++i, arg)
      continue
    }
    if (arg === '--operation') {
      filters.operation = readFlagValue(argv, ++i, arg)
      continue
    }
    if (arg === '--model') {
      filters.model = readFlagValue(argv, ++i, arg)
      continue
    }
    if (arg === '--ok') {
      filters.ok = parseBooleanFlag(readFlagValue(argv, ++i, arg), arg)
      continue
    }
    if (arg === '--side-effect') {
      filters.sideEffect = parseBooleanFlag(readFlagValue(argv, ++i, arg), arg)
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    positional.push(arg)
  }

  return {
    source,
    tokenUsagePath: positional[0] ?? 'logs/token-usage.ndjson',
    toolCallsPath: positional[1] ?? 'logs/tool-calls.ndjson',
    filters,
  }
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function parseSource(value: string): MetricsSource {
  if (value === 'log' || value === 'db') return value
  throw new Error(`Invalid --source value: ${value}`)
}

function parseDateFlag(value: string, flag: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid ${flag} date: ${value}`)
  }
  return date
}

function parseBooleanFlag(value: string, flag: string): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`Invalid ${flag} boolean: ${value}`)
}
