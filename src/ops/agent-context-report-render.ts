import type {
  AgentContextCategoryName,
  AgentContextReport,
} from './agent-context-report.js'

const categoryLabels: ReadonlyArray<readonly [AgentContextCategoryName, string]> = [
  ['systemIdentity', 'System identity'],
  ['botSystemPrompt', 'Bot system prompt'],
  ['visibleTools', 'Visible tools'],
  ['userAndRuntimeMessages', 'User/runtime'],
  ['assistantToolCalls', 'Assistant calls'],
  ['assistantThinking', 'Assistant thinking'],
  ['toolResultsText', 'Tool results'],
  ['workingImages', 'Working images'],
  ['assistantText', 'Assistant text'],
]

export function parseAgentContextArgs(args: string[]): { json: boolean } {
  if (args.length === 0) return { json: false }
  if (args.length === 1 && args[0] === '--json') return { json: true }
  if (args.length === 2 && args[0] === '--' && args[1] === '--json') return { json: true }
  throw new Error(`unknown argument: ${args.join(' ')}`)
}

export function renderCompactTokens(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('token value must be a non-negative safe integer')
  }
  if (value < 1_000) return value.toString()
  if (roundedUnit(value, 1_000) < 1_000) return `${roundedUnit(value, 1_000).toFixed(1)}k`
  if (roundedUnit(value, 1_000_000) < 1_000) {
    return `${roundedUnit(value, 1_000_000).toFixed(1)}m`
  }
  return `${(value / 1_000_000_000).toFixed(1)}b`
}

export function renderAgentContextReport(report: AgentContextReport): string {
  const latest = report.latestProviderUsage
  const lines = [
    'Context Usage',
    `Model: ${report.model === null ? 'n/a' : terminalText(report.model)}`,
    `Provider: ${report.provider ?? 'n/a'}`,
    `Window: ${formatTokens(report.contextWindowTokens)}`,
    `Estimated current: ${formatTokens(report.estimatedCurrentInputTokens)}${formatParenthesizedPercent(report.usagePercent)}`,
    `Known categories: ${renderCompactTokens(report.estimatedKnownInputTokens)} · complete ${report.estimateComplete ? 'yes' : 'no'}`,
    `Latest provider input: ${formatTokens(latest?.inputTokens ?? null)} · cached ${formatTokens(latest?.cachedTokens ?? null)} · output ${formatTokens(latest?.outputTokens ?? null)}`,
    `Latest provider sample: ${latest === null ? 'n/a' : `${terminalText(latest.ts)} · ${terminalText(latest.model)}`}`,
    '',
  ]

  for (const [name, label] of categoryLabels) {
    const category = report.categories[name]
    lines.push(renderMetricLine(label, category.tokens, category.percent))
  }
  lines.push(renderMetricLine(
    'Free space',
    report.freeTokens,
    percentage(report.freeTokens, report.contextWindowTokens),
  ))

  lines.push(
    '',
    `Compaction trigger: ${formatTokens(report.compaction.triggerTokens)} · headroom ${formatTokens(report.compaction.tokensUntilTrigger)} · over ${formatBoolean(report.compaction.overTrigger)}`,
    `Compaction policy: reserve ${renderCompactTokens(report.compaction.reserveTokens)} · keep recent ${renderCompactTokens(report.compaction.keepRecentTokens)}`,
    `Projection: canonical ${report.messages.canonical} · working ${report.messages.working}`,
    `Images: hydrated ${report.messages.hydratedImages} · omitted ${report.messages.omittedImages} · unavailable ${report.messages.unavailableImages}`,
    '',
    'Top tool-result contributors:',
    ...(report.toolResultContributors.length === 0
      ? ['- none']
      : report.toolResultContributors.slice(0, 5).map((contributor) => (
          `- ${terminalText(contributor.toolName)}  ${renderCompactTokens(contributor.tokens)}  ${contributor.resultCount} results`
        ))),
    `Estimate: ${report.estimateMethod}`,
    `Surface: ${report.surfaceStatus}`,
    `Generated: ${terminalText(report.generatedAt)}`,
  )

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:', ...report.warnings.map((warning) => `- ${terminalText(warning)}`))
  }

  return lines.join('\n')
}

export function renderAgentContextReportJson(report: AgentContextReport): string {
  return JSON.stringify(report, null, 2)
}

function renderMetricLine(label: string, tokens: number | null, percent: number | null): string {
  return `${label.padEnd(23)}${formatTokens(tokens).padStart(8)}${formatPercent(percent).padStart(8)}`
}

function formatTokens(value: number | null): string {
  return value === null ? 'n/a' : renderCompactTokens(value)
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`
}

function formatParenthesizedPercent(value: number | null): string {
  return value === null ? '' : ` (${value.toFixed(1)}%)`
}

function formatBoolean(value: boolean | null): string {
  return value === null ? 'n/a' : value ? 'yes' : 'no'
}

function percentage(value: number | null, total: number | null): number | null {
  if (value === null || total === null || total === 0) return null
  return Math.round(value / total * 1_000) / 10
}

function roundedUnit(value: number, divisor: number): number {
  return Math.round(value / divisor * 10) / 10
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ))
}
