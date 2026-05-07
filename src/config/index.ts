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

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return Math.floor(parsed)
}

/**
 * Parse a comma-separated ID list (`123,456` 之类) used for whitelist envs like
 * `BOT_TARGET_GROUP_IDS`.
 *
 * Rules (deterministic — affects system prompt byte stability):
 *  1. split on `,`
 *  2. trim each segment
 *  3. drop empty segments
 *  4. parse each as a number; non-numeric segments throw
 *  5. dedupe + ascending sort (same whitelist always produces same prompt text)
 *  6. empty after parsing → []  (caller decides if that's an error)
 */
export function parseIdList(name: string, raw: string | undefined): number[] {
  if (raw == null) return []
  const segments = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  const ids: number[] = []
  for (const seg of segments) {
    const parsed = Number(seg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error(`Invalid id "${seg}" in env ${name} (must be integer)`)
    }
    ids.push(parsed)
  }
  const unique = Array.from(new Set(ids))
  unique.sort((a, b) => a - b)
  return unique
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
  const scenarioFields = ['PROVIDER', 'MODEL'] as const

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
  }

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
  }

  return {
    defaultProvider,
    defaultModel,
    providers,
    scenarios,
  }
}

export function parseConfig(env: EnvSource) {
  const groupIds = parseIdList('BOT_TARGET_GROUP_IDS', env.BOT_TARGET_GROUP_IDS)

  const compactionTriggerTokens = parsePositiveInteger(env.COMPACTION_TRIGGER_TOKENS, 16_000)
  const idleHintMs = parsePositiveInteger(env.BOT_IDLE_HINT_MS, 1_800_000)
  const fetchRedditTimeoutMs = parsePositiveInteger(env.BOT_FETCH_REDDIT_TIMEOUT_MS, 8_000)
  const fetchUrlTimeoutMs = parsePositiveInteger(env.BOT_FETCH_URL_TIMEOUT_MS, 12_000)
  const fetchLogPath = env.BOT_FETCH_LOG_PATH && env.BOT_FETCH_LOG_PATH.trim().length > 0
    ? env.BOT_FETCH_LOG_PATH.trim()
    : 'logs/fetch.ndjson'

  return {
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    napcat: {
      wsUrl: requireEnv(env, 'NAPCAT_WS_URL'),
      accessToken: requireEnv(env, 'NAPCAT_ACCESS_TOKEN'),
    },
    /** Group whitelist. Bot listens + replies only within these IDs. 私聊不走白名单, 由 ingress 层 sub_type='friend' 过滤. */
    botTargetGroupIds: groupIds,
    selfNumber: Number(requireEnv(env, 'SELF_NUMBER')),
    nodeEnv: env.NODE_ENV || 'development',
    replyMediaTimeoutMs: parsePositiveInteger(env.REPLY_MEDIA_TIMEOUT_MS, 15_000),
    jobInterDelayMs: parsePositiveInteger(env.JOB_INTER_DELAY_MS, 200),
    /**
     * Compaction trigger token threshold (estimated). Default 16k bumped from 12k for
     * multi-source token-velocity. Override via COMPACTION_TRIGGER_TOKENS env.
     */
    compactionTriggerTokens,
    /**
     * Idle hint threshold for the wait tool. After this many ms with no real event,
     * wait returns an `[空闲提示]` tool result instead of blocking forever, giving
     * the LLM a chance to fetch something or start a topic. Default 30min.
     */
    idleHintMs,
    /** Hard timeout for fetch_reddit (AbortController). */
    fetchRedditTimeoutMs,
    /** Hard timeout for fetch_url (AbortController). */
    fetchUrlTimeoutMs,
    /** NDJSON sidecar log path. Not a Prisma table — operations data only. */
    fetchLogPath,
    tavily: env.TAVILY_API_KEY
      ? { apiKey: env.TAVILY_API_KEY }
      : undefined,
    llm: parseLlmConfig(env),
  } as const
}

export const config = parseConfig(process.env)
