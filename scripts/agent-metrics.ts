import { existsSync, readFileSync } from 'node:fs'
import { summarizeAgentMetrics } from '../src/ops/agent-metrics.js'

const tokenUsagePath = process.argv[2] ?? 'logs/token-usage.ndjson'
const toolCallsPath = process.argv[3] ?? 'logs/tool-calls.ndjson'

const summary = summarizeAgentMetrics({
  tokenUsageNdjson: readIfExists(tokenUsagePath),
  toolCallsNdjson: readIfExists(toolCallsPath),
})

console.log(JSON.stringify({
  tokenUsagePath,
  toolCallsPath,
  ...summary,
}, null, 2))

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
