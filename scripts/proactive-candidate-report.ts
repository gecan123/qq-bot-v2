import {
  collectProactiveCandidateMetrics,
  formatProactiveCandidateMetricsCsv,
  formatProactiveCandidateMetricsMarkdown,
} from '../src/observability/proactive-candidate-metrics.js'
import {
  parseProactiveCandidateReportArgs,
  proactiveCandidateReportUsage,
  type ProactiveCandidateReportCliOptions,
} from '../src/observability/proactive-candidate-report-cli.js'
import { pathToFileURL } from 'node:url'

async function main(): Promise<void> {
  let options: ProactiveCandidateReportCliOptions
  try {
    options = parseProactiveCandidateReportArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'usage') {
      console.error(message)
    }
    console.error(proactiveCandidateReportUsage())
    process.exitCode = message === 'usage' ? 0 : 1
    return
  }

  const metrics = await collectProactiveCandidateMetrics({
    from: options.from,
    to: options.to,
    groupId: options.groupId,
    reviewLimit: options.limit,
    maxAudits: options.maxAudits,
  })

  if (options.format === 'json') {
    console.log(JSON.stringify(metrics, null, 2))
  } else if (options.format === 'csv') {
    process.stdout.write(formatProactiveCandidateMetricsCsv(metrics))
  } else {
    process.stdout.write(formatProactiveCandidateMetricsMarkdown(metrics))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
