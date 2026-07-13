import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { formatBeijingIso } from '../utils/beijing-time.js'

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_TOKEN_USAGE_PATH = 'logs/token-usage.ndjson'
const DEFAULT_LOGS_DIR = 'logs'
const DEFAULT_EXCLUDED_MODELS = ['mock'] as const

export interface DailyAgentMetricsOptions {
  /** 统计截止自然日；省略时使用北京时间今天。 */
  date?: string
  /** 向前连续统计多少个自然日，包含 date；默认 1，最大 31。 */
  days?: number
  /** 相对北京时间今天偏移截止自然日；workspace_bash yesterday 使用 -1。 */
  endOffsetDays?: number
  now?: Date
  tokenUsagePath?: string
  logsDir?: string
  appLogPaths?: string[]
  excludedModels?: readonly string[]
}

export interface DailyTokenUsageBucket {
  entries: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  totalTokens: number
  uncachedInputTokens: number
  uncachedPlusOutputTokens: number
  cacheHitRate: number | null
}

export interface DailyAgentMetricsReport {
  date: string
  from: string
  toExclusive: string
  tokenUsage: {
    total: DailyTokenUsageBucket
    byOperation: Record<string, DailyTokenUsageBucket>
  }
  toolCalls: {
    rounds: number
    total: number
    byTool: Record<string, number>
    /** 旧日志没有 effectiveToolNames，或 invoke 缺少合法 target 时无法展开。 */
    unresolvedInvokeCalls: number
  }
  rest: {
    requests: number
    started: number
    redirected: number
    confirmationRejected: number
    confirmed: number
    elapsed: number
    interrupted: number
    requestedSeconds: {
      total: number
      average: number | null
      max: number | null
    }
    reasons: {
      waitingForPersonOrMessage: number
      completion: number
      timeOfDay: number
      marketPolling: number
      other: number
    }
    redirectSources: {
      recentContext: number
      agenda: number
      journal: number
      wishes: number
      unknown: number
    }
    postRedirect: {
      observed: number
      acted: number
      restedInstead: number
      unknown: number
    }
    postRest: {
      observed: number
      acted: number
      restedAgain: number
      unknown: number
    }
  }
}

export interface DailyAgentMetricsResult {
  timezone: 'Asia/Shanghai'
  generatedAt: string
  excludedModels: string[]
  reports: DailyAgentMetricsReport[]
  diagnostics: {
    tokenUsagePath: string
    appLogFilesScanned: number
    malformedTokenLines: number
    malformedAppLogLines: number
    missingFiles: string[]
  }
}

export interface DailyAgentMetricsInput {
  tokenUsageNdjson: string
  appLogNdjson: string
}

interface MutableTokenBucket {
  entries: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
}

interface MutableDay {
  date: string
  fromMs: number
  toMs: number
  tokenTotal: MutableTokenBucket
  tokenByOperation: Record<string, MutableTokenBucket>
  rounds: number
  toolCalls: number
  byTool: Record<string, number>
  unresolvedInvokeCalls: number
  rest: MutableRestMetrics
}

interface MutableRestMetrics {
  started: number
  redirected: number
  confirmationRejected: number
  confirmed: number
  elapsed: number
  interrupted: number
  requestedSecondsTotal: number
  requestedSecondsMax: number | null
  reasons: DailyAgentMetricsReport['rest']['reasons']
  redirectSources: DailyAgentMetricsReport['rest']['redirectSources']
  postRedirectActed: number
  postRedirectRestedInstead: number
  postRedirectUnknown: number
  awaitingPostRedirectAction: boolean
  postRestActed: number
  postRestRestedAgain: number
  postRestRestedAgainUnverified: number
  postRestUnknown: number
  awaitingPostRestAction: boolean
  toolCompletionEvidenceAvailable: boolean
}

interface TokenUsageLine {
  ts?: unknown
  operation?: unknown
  model?: unknown
  inputTokens?: unknown
  cachedTokens?: unknown
  outputTokens?: unknown
}

interface AppLogLine {
  time?: unknown
  msg?: unknown
  model?: unknown
  toolNames?: unknown
  effectiveToolNames?: unknown
  toolName?: unknown
  ok?: unknown
  durationSeconds?: unknown
  reason?: unknown
  anchorSource?: unknown
  confirmed?: unknown
}

interface Accumulator {
  addTokenLine(line: string): void
  addAppLogLine(line: string): void
  finish(args: {
    generatedAt: Date
    tokenUsagePath: string
    appLogFilesScanned: number
    missingFiles: string[]
  }): DailyAgentMetricsResult
  earliestFromMs: number
}

export function resolveDailyMetricDates(options: Pick<DailyAgentMetricsOptions, 'date' | 'days' | 'endOffsetDays' | 'now'> = {}): string[] {
  const days = options.days ?? 1
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw new Error('days must be an integer between 1 and 31')
  }
  if (options.date && options.endOffsetDays != null) {
    throw new Error('date and endOffsetDays cannot be used together')
  }
  if (options.endOffsetDays != null && (!Number.isInteger(options.endOffsetDays) || options.endOffsetDays > 0)) {
    throw new Error('endOffsetDays must be a non-positive integer')
  }

  const today = beijingDate(options.now ?? new Date())
  const endDate = options.date ?? shiftBeijingDate(today, options.endOffsetDays ?? 0)
  assertDate(endDate)

  return Array.from({ length: days }, (_, index) => shiftBeijingDate(endDate, index - days + 1))
}

export function summarizeDailyAgentMetrics(
  input: DailyAgentMetricsInput,
  options: Pick<DailyAgentMetricsOptions, 'date' | 'days' | 'endOffsetDays' | 'now' | 'excludedModels'> = {},
): DailyAgentMetricsResult {
  const dates = resolveDailyMetricDates(options)
  const accumulator = createAccumulator(dates, options.excludedModels ?? DEFAULT_EXCLUDED_MODELS)
  for (const line of input.tokenUsageNdjson.split('\n')) accumulator.addTokenLine(line)
  for (const line of input.appLogNdjson.split('\n')) accumulator.addAppLogLine(line)
  return accumulator.finish({
    generatedAt: options.now ?? new Date(),
    tokenUsagePath: '<memory>',
    appLogFilesScanned: input.appLogNdjson.length > 0 ? 1 : 0,
    missingFiles: [],
  })
}

export async function loadDailyAgentMetrics(options: DailyAgentMetricsOptions = {}): Promise<DailyAgentMetricsResult> {
  const dates = resolveDailyMetricDates(options)
  const excludedModels = options.excludedModels ?? DEFAULT_EXCLUDED_MODELS
  const tokenUsagePath = options.tokenUsagePath ?? DEFAULT_TOKEN_USAGE_PATH
  const logsDir = options.logsDir ?? DEFAULT_LOGS_DIR
  const accumulator = createAccumulator(dates, excludedModels)
  const missingFiles: string[] = []

  await consumeFile(tokenUsagePath, (line) => accumulator.addTokenLine(line), missingFiles)

  const appLogPaths = options.appLogPaths
    ?? await discoverRelevantAppLogs(logsDir, accumulator.earliestFromMs)
  let appLogFilesScanned = 0
  for (const path of appLogPaths) {
    const consumed = await consumeFile(path, (line) => accumulator.addAppLogLine(line), missingFiles)
    if (consumed) appLogFilesScanned++
  }

  return accumulator.finish({
    generatedAt: options.now ?? new Date(),
    tokenUsagePath,
    appLogFilesScanned,
    missingFiles,
  })
}

function createAccumulator(dates: readonly string[], excludedModels: readonly string[]): Accumulator {
  const excluded = new Set(excludedModels)
  const days = new Map<string, MutableDay>()
  for (const date of dates) {
    const fromMs = beijingStartMs(date)
    days.set(date, {
      date,
      fromMs,
      toMs: fromMs + DAY_MS,
      tokenTotal: createTokenBucket(),
      tokenByOperation: {},
      rounds: 0,
      toolCalls: 0,
      byTool: {},
      unresolvedInvokeCalls: 0,
      rest: createRestMetrics(),
    })
  }

  let malformedTokenLines = 0
  let malformedAppLogLines = 0

  return {
    earliestFromMs: Math.min(...Array.from(days.values(), (day) => day.fromMs)),
    addTokenLine(raw) {
      const parsed = parseLine<TokenUsageLine>(raw)
      if (parsed === 'empty') return
      if (parsed === null) {
        malformedTokenLines++
        return
      }
      if (typeof parsed.model === 'string' && excluded.has(parsed.model)) return
      const day = dayForTimestamp(parsed.ts, days)
      if (!day) return
      const operation = typeof parsed.operation === 'string' && parsed.operation.length > 0
        ? parsed.operation
        : 'unknown'
      const operationBucket = (day.tokenByOperation[operation] ??= createTokenBucket())
      addTokenUsage(day.tokenTotal, parsed)
      addTokenUsage(operationBucket, parsed)
    },
    addAppLogLine(raw) {
      const parsed = parseLine<AppLogLine>(raw)
      if (parsed === 'empty') return
      if (parsed === null) {
        malformedAppLogLines++
        return
      }
      const day = dayForTimestamp(parsed.time, days)
      if (!day) return

      if (parsed.msg === 'rest_enter') {
        if (day.rest.awaitingPostRedirectAction) {
          day.rest.postRedirectRestedInstead++
          day.rest.awaitingPostRedirectAction = false
        }
        if (day.rest.awaitingPostRestAction) {
          if (day.rest.toolCompletionEvidenceAvailable) {
            day.rest.postRestRestedAgain++
          } else {
            day.rest.postRestRestedAgainUnverified++
          }
          day.rest.awaitingPostRestAction = false
        }
        day.rest.started++
        if (parsed.confirmed === true) day.rest.confirmed++
        const durationSeconds = numeric(parsed.durationSeconds)
        day.rest.requestedSecondsTotal += durationSeconds
        day.rest.requestedSecondsMax = Math.max(day.rest.requestedSecondsMax ?? 0, durationSeconds)
        addRestReason(day.rest, parsed.reason)
        return
      }
      if (parsed.msg === 'rest_redirected') {
        if (day.rest.awaitingPostRedirectAction) day.rest.postRedirectUnknown++
        day.rest.redirected++
        addRedirectSource(day.rest, parsed.anchorSource)
        day.rest.awaitingPostRedirectAction = true
        addRestReason(day.rest, parsed.reason)
        return
      }
      if (parsed.msg === 'rest_confirmation_rejected') {
        day.rest.confirmationRejected++
        addRestReason(day.rest, parsed.reason)
        return
      }
      if (parsed.msg === 'rest_elapsed') {
        day.rest.elapsed++
        if (day.rest.awaitingPostRestAction) day.rest.postRestUnknown++
        day.rest.awaitingPostRestAction = true
        return
      }
      if (parsed.msg === 'rest_interrupted') {
        day.rest.interrupted++
        return
      }
      if (parsed.msg === 'round_tool_done') {
        if (!day.rest.toolCompletionEvidenceAvailable) {
          day.rest.toolCompletionEvidenceAvailable = true
          day.rest.postRestRestedAgain += day.rest.postRestRestedAgainUnverified
          day.rest.postRestRestedAgainUnverified = 0
        }
        if (
          day.rest.awaitingPostRedirectAction
          && parsed.ok !== false
          && typeof parsed.toolName === 'string'
          && parsed.toolName !== 'pause'
          && parsed.toolName !== 'rest'
          && parsed.toolName !== 'help'
        ) {
          day.rest.postRedirectActed++
          day.rest.awaitingPostRedirectAction = false
        }
        if (
          day.rest.awaitingPostRestAction
          && parsed.ok !== false
          && typeof parsed.toolName === 'string'
          && parsed.toolName !== 'pause'
          && parsed.toolName !== 'rest'
          && parsed.toolName !== 'help'
        ) {
          day.rest.postRestActed++
          day.rest.awaitingPostRestAction = false
        }
        return
      }
      if (parsed.msg !== 'round_llm_done') return
      if (typeof parsed.model === 'string' && excluded.has(parsed.model)) return

      const rawNames = stringArray(parsed.toolNames)
      const effectiveNames = stringArray(parsed.effectiveToolNames)
      const names = effectiveNames && rawNames && effectiveNames.length === rawNames.length
        ? effectiveNames
        : (rawNames ?? [])
      day.rounds++
      for (const name of names) {
        day.toolCalls++
        day.byTool[name] = (day.byTool[name] ?? 0) + 1
        if (name === 'invoke') day.unresolvedInvokeCalls++
      }
    },
    finish(args) {
      return {
        timezone: 'Asia/Shanghai',
        generatedAt: formatBeijingIso(args.generatedAt),
        excludedModels: [...excluded],
        reports: dates.map((date) => finalizeDay(days.get(date)!)),
        diagnostics: {
          tokenUsagePath: args.tokenUsagePath,
          appLogFilesScanned: args.appLogFilesScanned,
          malformedTokenLines,
          malformedAppLogLines,
          missingFiles: args.missingFiles,
        },
      }
    },
  }
}

function finalizeDay(day: MutableDay): DailyAgentMetricsReport {
  return {
    date: day.date,
    from: formatBeijingIso(new Date(day.fromMs)),
    toExclusive: formatBeijingIso(new Date(day.toMs)),
    tokenUsage: {
      total: finalizeTokenBucket(day.tokenTotal),
      byOperation: Object.fromEntries(
        Object.entries(day.tokenByOperation)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([operation, bucket]) => [operation, finalizeTokenBucket(bucket)]),
      ),
    },
    toolCalls: {
      rounds: day.rounds,
      total: day.toolCalls,
      byTool: Object.fromEntries(
        Object.entries(day.byTool).sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName)),
      ),
      unresolvedInvokeCalls: day.unresolvedInvokeCalls,
    },
    rest: finalizeRestMetrics(day.rest),
  }
}

function createRestMetrics(): MutableRestMetrics {
  return {
    started: 0,
    redirected: 0,
    confirmationRejected: 0,
    confirmed: 0,
    elapsed: 0,
    interrupted: 0,
    requestedSecondsTotal: 0,
    requestedSecondsMax: null,
    reasons: {
      waitingForPersonOrMessage: 0,
      completion: 0,
      timeOfDay: 0,
      marketPolling: 0,
      other: 0,
    },
    redirectSources: {
      recentContext: 0,
      agenda: 0,
      journal: 0,
      wishes: 0,
      unknown: 0,
    },
    postRedirectActed: 0,
    postRedirectRestedInstead: 0,
    postRedirectUnknown: 0,
    awaitingPostRedirectAction: false,
    postRestActed: 0,
    postRestRestedAgain: 0,
    postRestRestedAgainUnverified: 0,
    postRestUnknown: 0,
    awaitingPostRestAction: false,
    toolCompletionEvidenceAvailable: false,
  }
}

function addRedirectSource(rest: MutableRestMetrics, rawSource: unknown): void {
  switch (rawSource) {
    case 'recent_context':
      rest.redirectSources.recentContext++
      break
    case 'agenda':
      rest.redirectSources.agenda++
      break
    case 'journal':
      rest.redirectSources.journal++
      break
    case 'wishes':
      rest.redirectSources.wishes++
      break
    default:
      rest.redirectSources.unknown++
  }
}

function addRestReason(rest: MutableRestMetrics, rawReason: unknown): void {
  const reason = typeof rawReason === 'string' ? rawReason : ''
  let matched = false
  if (/(?:等|等待|没回|未回|不在线|离线|睡了|睡觉|消息|回复)/i.test(reason)) {
    rest.reasons.waitingForPersonOrMessage++
    matched = true
  }
  if (/(?:完成|做完|结束|告一段落|收工|没事|无事可做|都处理完)/i.test(reason)) {
    rest.reasons.completion++
    matched = true
  }
  if (/(?:深夜|凌晨|晚上|中午|天亮|时间晚|该睡|休息时间)/i.test(reason)) {
    rest.reasons.timeOfDay++
    matched = true
  }
  if (/(?:价格|行情|走势|K\s*线|市场|观察|盯盘|SOL|BTC|ETH)/i.test(reason)) {
    rest.reasons.marketPolling++
    matched = true
  }
  if (!matched) rest.reasons.other++
}

function finalizeRestMetrics(rest: MutableRestMetrics): DailyAgentMetricsReport['rest'] {
  const postRedirectUnknown = rest.postRedirectUnknown + (rest.awaitingPostRedirectAction ? 1 : 0)
  const postRedirectObserved = rest.postRedirectActed
    + rest.postRedirectRestedInstead
    + postRedirectUnknown
  const unknown = rest.postRestUnknown
    + rest.postRestRestedAgainUnverified
    + (rest.awaitingPostRestAction ? 1 : 0)
  const observed = rest.postRestActed + rest.postRestRestedAgain + unknown
  return {
    requests: rest.started + rest.redirected + rest.confirmationRejected,
    started: rest.started,
    redirected: rest.redirected,
    confirmationRejected: rest.confirmationRejected,
    confirmed: rest.confirmed,
    elapsed: rest.elapsed,
    interrupted: rest.interrupted,
    requestedSeconds: {
      total: rest.requestedSecondsTotal,
      average: rest.started > 0 ? round(rest.requestedSecondsTotal / rest.started) : null,
      max: rest.requestedSecondsMax,
    },
    reasons: { ...rest.reasons },
    redirectSources: { ...rest.redirectSources },
    postRedirect: {
      observed: postRedirectObserved,
      acted: rest.postRedirectActed,
      restedInstead: rest.postRedirectRestedInstead,
      unknown: postRedirectUnknown,
    },
    postRest: {
      observed,
      acted: rest.postRestActed,
      restedAgain: rest.postRestRestedAgain,
      unknown,
    },
  }
}

function createTokenBucket(): MutableTokenBucket {
  return { entries: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
}

function addTokenUsage(bucket: MutableTokenBucket, line: TokenUsageLine): void {
  bucket.entries++
  bucket.inputTokens += numeric(line.inputTokens)
  bucket.cachedTokens += numeric(line.cachedTokens)
  bucket.outputTokens += numeric(line.outputTokens)
}

function finalizeTokenBucket(bucket: MutableTokenBucket): DailyTokenUsageBucket {
  const uncachedInputTokens = Math.max(0, bucket.inputTokens - bucket.cachedTokens)
  return {
    entries: bucket.entries,
    inputTokens: bucket.inputTokens,
    cachedTokens: bucket.cachedTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.inputTokens + bucket.outputTokens,
    uncachedInputTokens,
    uncachedPlusOutputTokens: uncachedInputTokens + bucket.outputTokens,
    cacheHitRate: bucket.inputTokens > 0 ? round(bucket.cachedTokens / bucket.inputTokens) : null,
  }
}

function dayForTimestamp(ts: unknown, days: ReadonlyMap<string, MutableDay>): MutableDay | null {
  if (typeof ts !== 'string') return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
    ? `${ts.replace(' ', 'T')}+08:00`
    : ts
  const time = Date.parse(normalized)
  if (!Number.isFinite(time)) return null
  return days.get(beijingDate(new Date(time))) ?? null
}

function parseLine<T>(raw: string): T | null | 'empty' {
  const trimmed = raw.trim()
  if (!trimmed) return 'empty'
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) return null
  return value
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function beijingDate(date: Date): string {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

function shiftBeijingDate(date: string, days: number): string {
  assertDate(date)
  return beijingDate(new Date(beijingStartMs(date) + days * DAY_MS))
}

function beijingStartMs(date: string): number {
  assertDate(date)
  return Date.parse(`${date}T00:00:00+08:00`)
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) throw new Error(`invalid date: ${date}`)
  const parsed = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(parsed) || beijingDate(new Date(parsed)) !== date) {
    throw new Error(`invalid date: ${date}`)
  }
}

async function discoverRelevantAppLogs(logsDir: string, earliestFromMs: number): Promise<string[]> {
  let entries
  try {
    entries = await readdir(logsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^app(?:\.\d+)?\.log$/.test(entry.name))
    .map((entry) => join(logsDir, entry.name))
    .sort()
  const relevant: string[] = []
  for (const path of candidates) {
    const info = await stat(path)
    if (info.mtimeMs >= earliestFromMs) relevant.push(path)
  }
  return relevant
}

async function consumeFile(
  path: string,
  consume: (line: string) => void,
  missingFiles: string[],
): Promise<boolean> {
  let stream
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
    await new Promise<void>((resolveReady, rejectReady) => {
      stream!.once('open', () => resolveReady())
      stream!.once('error', rejectReady)
    })
  } catch (error) {
    if (isMissingFileError(error)) {
      missingFiles.push(path)
      return false
    }
    throw error
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) consume(line)
  return true
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
