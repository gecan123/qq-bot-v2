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
    botProactiveDryRun: parseBoolean(env.BOT_PROACTIVE_DRY_RUN, false),
    botAmbientAuditEnabled: parseBoolean(env.BOT_AMBIENT_AUDIT_ENABLED, true),
    botAmbientReplyBaseProbability: parseProbability(env.BOT_AMBIENT_REPLY_BASE_PROBABILITY, 0.02),
    runtimeContextFallback: parseRuntimeContextFallback(env.RUNTIME_CONTEXT_FALLBACK),
    runtimeSchedulerTickMs: parseNonNegativeInteger(env.RUNTIME_SCHEDULER_TICK_MS, 0),
    proactivePolicy: {
      activeChatMessageThreshold: parsePositiveInteger(env.PROACTIVE_ACTIVE_CHAT_MESSAGE_THRESHOLD, 12),
      activeChatWindowMs: parsePositiveInteger(env.PROACTIVE_ACTIVE_CHAT_WINDOW_MS, 120_000),
      cooldownMs: parsePositiveInteger(env.PROACTIVE_COOLDOWN_MS, 600_000),
      generationBudgetPerHour: parsePositiveInteger(env.PROACTIVE_GENERATION_BUDGET_PER_HOUR, 1000),
      candidateBudgetPerDay: parsePositiveInteger(env.PROACTIVE_CANDIDATE_BUDGET_PER_DAY, 10000),
    },
    proactiveJudge: {
      enabled: parseBoolean(env.PROACTIVE_JUDGE_ENABLED, false),
      timeoutMs: parsePositiveInteger(env.PROACTIVE_JUDGE_TIMEOUT_MS, 3000),
      maxCallsPerHour: parsePositiveInteger(env.PROACTIVE_JUDGE_MAX_CALLS_PER_HOUR, 100),
      minConfidence: parseProbability(env.PROACTIVE_JUDGE_MIN_CONFIDENCE, 0.6),
      minUsefulness: parseProbability(env.PROACTIVE_JUDGE_MIN_USEFULNESS, 0.6),
      minNovelty: parseProbability(env.PROACTIVE_JUDGE_MIN_NOVELTY, 0.3),
      maxInterruptionCost: parseProbability(env.PROACTIVE_JUDGE_MAX_INTERRUPTION_COST, 0.4),
      maxSocialRisk: parseProbability(env.PROACTIVE_JUDGE_MAX_SOCIAL_RISK, 0.3),
      maxSuggestedDelayMs: parseNonNegativeInteger(env.PROACTIVE_JUDGE_MAX_SUGGESTED_DELAY_MS, 300_000),
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
