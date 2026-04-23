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
