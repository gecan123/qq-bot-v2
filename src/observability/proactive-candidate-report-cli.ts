export type ProactiveCandidateReportFormat = 'markdown' | 'json' | 'csv'

export interface ProactiveCandidateReportCliOptions {
  from: Date
  to: Date
  groupId?: number
  format: ProactiveCandidateReportFormat
  limit: number
  maxAudits?: number
}

function parseDate(value: string, endExclusive: boolean): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }
  if (dateOnly && endExclusive) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return date
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function parseProactiveCandidateReportArgs(argv: string[]): ProactiveCandidateReportCliOptions {
  const now = new Date()
  const defaultTo = now
  const defaultFrom = new Date(defaultTo.getTime() - 7 * 24 * 60 * 60 * 1000)
  const options: ProactiveCandidateReportCliOptions = {
    from: defaultFrom,
    to: defaultTo,
    format: 'markdown',
    limit: 50,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue

    const [name, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const nextValue = () => {
      const value = inlineValue ?? argv[++index]
      if (!value) throw new Error(`Missing value for ${name}`)
      return value
    }

    switch (name) {
      case '--from':
        options.from = parseDate(nextValue(), false)
        break
      case '--to':
        options.to = parseDate(nextValue(), true)
        break
      case '--group':
        options.groupId = parsePositiveInt('--group', nextValue())
        break
      case '--format': {
        const format = nextValue()
        if (format !== 'markdown' && format !== 'json' && format !== 'csv') {
          throw new Error('--format must be markdown, json, or csv')
        }
        options.format = format
        break
      }
      case '--limit':
        options.limit = parsePositiveInt('--limit', nextValue())
        break
      case '--max-audits':
        options.maxAudits = parsePositiveInt('--max-audits', nextValue())
        break
      case '--help':
      case '-h':
        throw new Error('usage')
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.from >= options.to) {
    throw new Error('--from must be before --to')
  }

  return options
}

export function proactiveCandidateReportUsage(): string {
  return [
    'Usage: pnpm proactive:report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--group GROUP_ID] [--format markdown|json|csv] [--limit N]',
    '',
    'Defaults: last 7 days, markdown, review queue limit 50.',
  ].join('\n')
}
