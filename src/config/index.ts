import 'dotenv/config'

type EnvSource = Record<string, string | undefined>

type LlmScenarioKey =
  | 'describeImage'
  | 'describeVideo'
  | 'describePdf'
  | 'transcribeAudio'

type ProviderConfig = {
  url: string
  apiKey: string
}

type LlmScenarioConfig = {
  provider?: string
  model?: string
  fallbackProvider?: string
  fallbackModel?: string
  fallbackGptStreamMode?: 'off' | 'fallback' | 'on'
  streamMode?: 'off' | 'fallback'
}

const SCENARIO_NAME_MAP: Record<string, LlmScenarioKey> = {
  DESCRIBE_IMAGE: 'describeImage',
  DESCRIBE_VIDEO: 'describeVideo',
  DESCRIBE_PDF: 'describePdf',
  TRANSCRIBE_AUDIO: 'transcribeAudio',
}

function requireEnv(env: EnvSource, name: string): string {
  const value = env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value == null) return defaultValue
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseProbability(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.max(0, Math.min(1, parsed))
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return Math.floor(parsed)
}

function parseNonNegativeInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue
  return Math.floor(parsed)
}

function parseRuntimeContextFallback(value: string | undefined): 'runtime' | 'ledger' {
  return value?.trim().toLowerCase() === 'ledger' ? 'ledger' : 'runtime'
}

function parseCsv(value: string | undefined, defaultValue: string[]): string[] {
  if (!value?.trim()) return defaultValue
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseProviderConfigs(env: EnvSource): Record<string, ProviderConfig> {
  const providers: Record<string, Partial<ProviderConfig>> = {}

  for (const [name, value] of Object.entries(env)) {
    if (!value) continue

    const match = name.match(/^LLM_PROVIDER_([A-Z0-9_]+)_(URL|API_KEY)$/)
    if (!match) continue

    const [, rawProviderName, field] = match
    const providerName = rawProviderName.toLowerCase()
    const provider = (providers[providerName] ??= {})

    if (field === 'URL') provider.url = value
    if (field === 'API_KEY') provider.apiKey = value
  }

  return Object.fromEntries(
    Object.entries(providers).map(([providerName, provider]) => {
      if (!provider.url || !provider.apiKey) {
        throw new Error(`Incomplete provider configuration for ${providerName}`)
      }
      return [providerName, { url: provider.url, apiKey: provider.apiKey }]
    }),
  )
}

function parseScenarioConfigs(env: EnvSource): Record<LlmScenarioKey, LlmScenarioConfig> {
  const scenarios = Object.fromEntries(
    Object.values(SCENARIO_NAME_MAP).map((key) => [key, {}]),
  ) as Record<LlmScenarioKey, LlmScenarioConfig>
  const scenarioFields = [
    'FALLBACK_PROVIDER',
    'FALLBACK_MODEL',
    'FALLBACK_GPT_STREAM_MODE',
    'STREAM_MODE',
    'PROVIDER',
    'MODEL',
  ] as const

  for (const [name, value] of Object.entries(env)) {
    if (!value) continue

    const prefix = 'LLM_SCENARIO_'
    if (!name.startsWith(prefix)) continue

    const matchedField = scenarioFields.find((field) => name.endsWith(`_${field}`))
    if (!matchedField) continue

    const rawScenarioName = name.slice(prefix.length, -(matchedField.length + 1))
    const scenarioName = SCENARIO_NAME_MAP[rawScenarioName]
    if (!scenarioName) continue

    if (matchedField === 'PROVIDER') scenarios[scenarioName].provider = value.toLowerCase()
    if (matchedField === 'MODEL') scenarios[scenarioName].model = value
    if (matchedField === 'FALLBACK_PROVIDER') scenarios[scenarioName].fallbackProvider = value.toLowerCase()
    if (matchedField === 'FALLBACK_MODEL') scenarios[scenarioName].fallbackModel = value
    if (matchedField === 'FALLBACK_GPT_STREAM_MODE') {
      scenarios[scenarioName].fallbackGptStreamMode = value === 'on' ? 'on' : value === 'fallback' ? 'fallback' : 'off'
    }
    if (matchedField === 'STREAM_MODE') {
      scenarios[scenarioName].streamMode = value === 'fallback' ? 'fallback' : 'off'
    }
  }

  scenarios.describeImage.streamMode ??= 'off'
  return scenarios
}

function parseLlmConfig(env: EnvSource) {
  const providers = parseProviderConfigs(env)
  const defaultProvider = requireEnv(env, 'LLM_DEFAULT_PROVIDER').toLowerCase()
  const defaultModel = requireEnv(env, 'LLM_DEFAULT_MODEL')

  if (!providers[defaultProvider]) {
    throw new Error(`Missing provider configuration for LLM_DEFAULT_PROVIDER: ${defaultProvider}`)
  }

  const scenarios = parseScenarioConfigs(env)
  for (const [scenarioName, scenario] of Object.entries(scenarios)) {
    if (scenario.provider && !providers[scenario.provider]) {
      throw new Error(`Missing provider configuration for scenario ${scenarioName}: ${scenario.provider}`)
    }
    if (scenario.fallbackProvider && !providers[scenario.fallbackProvider]) {
      throw new Error(`Missing fallback provider configuration for scenario ${scenarioName}: ${scenario.fallbackProvider}`)
    }
  }

  return {
    defaultProvider,
    defaultModel,
    providers,
    scenarios,
  }
}

export function parseConfig(env: EnvSource) {
  return {
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    napcat: {
      wsUrl: requireEnv(env, 'NAPCAT_WS_URL'),
      accessToken: requireEnv(env, 'NAPCAT_ACCESS_TOKEN'),
    },
    groupIds: requireEnv(env, 'GROUP_IDS').split(',').map(Number),
    selfNumber: Number(requireEnv(env, 'SELF_NUMBER')),
    botReplyDryRun: parseBoolean(env.BOT_REPLY_DRY_RUN, false),
    runtimeContextFallback: parseRuntimeContextFallback(env.RUNTIME_CONTEXT_FALLBACK),
    runtimeSchedulerTickMs: parseNonNegativeInteger(env.RUNTIME_SCHEDULER_TICK_MS, 0),
    v2exForum: {
      enabled: parseBoolean(env.V2EX_FORUM_ENABLED, false),
      feeds: parseCsv(env.V2EX_FORUM_FEEDS, ['latest']),
      pollIntervalMs: parseNonNegativeInteger(env.V2EX_FORUM_POLL_INTERVAL_MS, 30 * 60_000),
      maxItemsPerFeed: parsePositiveInteger(env.V2EX_FORUM_MAX_ITEMS_PER_FEED, 20),
      timeoutMs: parsePositiveInteger(env.V2EX_FORUM_TIMEOUT_MS, 15_000),
      userAgent: env.V2EX_FORUM_USER_AGENT?.trim() || 'qq-bot-v2 read-only forum connector (+https://www.v2ex.com)',
      interestKeywords: parseCsv(env.V2EX_FORUM_INTEREST_KEYWORDS, [
        'ai',
        'agent',
        'claude',
        'openai',
        'llm',
        'gpt',
        '编程',
        '程序员',
        '开发',
        '代码',
        '产品',
        '工具',
        '效率',
      ]),
      fetchDetails: parseBoolean(env.V2EX_FORUM_FETCH_DETAILS, true),
      detailReplyLimit: parseNonNegativeInteger(env.V2EX_FORUM_DETAIL_REPLY_LIMIT, 20),
    },
    proactive: {
      intervalMs: parseNonNegativeInteger(env.PROACTIVE_SCHEDULER_INTERVAL_MS, 0),
      initialDelayMs: parseNonNegativeInteger(env.PROACTIVE_SCHEDULER_INITIAL_DELAY_MS, 30_000),
      maxDigestItems: parsePositiveInteger(env.PROACTIVE_DIGEST_MAX_ITEMS, 12),
    },
    idleThread: {
      // Phase 1c: bot 空闲反思,默认关闭。建议起步 30 min (1800000) 看效果再调
      intervalMs: parseNonNegativeInteger(env.IDLE_THREAD_INTERVAL_MS, 0),
      initialDelayMs: parseNonNegativeInteger(env.IDLE_THREAD_INITIAL_DELAY_MS, 60_000),
      activeWithinHours: parsePositiveInteger(env.IDLE_THREAD_ACTIVE_HOURS, 24),
      recentJournalLimit: parsePositiveInteger(env.IDLE_THREAD_RECENT_JOURNAL_LIMIT, 3),
    },
    nodeEnv: env.NODE_ENV || 'development',
    replyMediaTimeoutMs: Number(env.REPLY_MEDIA_TIMEOUT_MS ?? '15000'),
    jobInterDelayMs: Number(env.JOB_INTER_DELAY_MS ?? '200'),
    tavily: env.TAVILY_API_KEY
      ? { apiKey: env.TAVILY_API_KEY }
      : undefined,
    llm: parseLlmConfig(env),
  } as const
}

export const config = parseConfig(process.env)
