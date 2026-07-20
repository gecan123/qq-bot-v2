import 'dotenv/config'
import { isAbsolute } from 'node:path'
import { loadGroupPolicies, type GroupPolicy } from './group-policies.js'

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
  reasoningEffort?: OpenAiReasoningEffort
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type ClaudeThinkingMode = 'disabled' | 'adaptive'
type ClaudeThinkingRetention = 'active-tool-cycle' | 'always'
type ClaudeThinkingLog = 'off' | 'summary' | 'raw'

type ClaudeThinkingConfig = {
  mode: ClaudeThinkingMode
  retention: ClaudeThinkingRetention
  log: ClaudeThinkingLog
}

type WebsiteConfig = {
  repoDir: string
  publicUrl?: string
  branch: string
  checkCommand: string
  commandTimeoutMs: number
}

type MoomooConfig = {
  skillDir: string
  pythonBin: string
  opendPort: number
  timeoutMs: number
}

type CryptoPaperConfig = {
  initialCash: number
  feeRateBps: number
}

export type VibeTradingConfig = {
  baseUrl: string
  apiKey?: string
  requestTimeoutMs: number
  taskTimeoutMs: number
  pollIntervalMs: number
  resultMaxChars: number
}

export const CLAUDE_CODE_PROVIDER_NAME = 'claude-code'
export const OPENAI_AGENT_PROVIDER_NAME = 'openai-agent'
export const OPENAI_AGENT_BASE_PROVIDER_NAME = 'openai'

/**
 * `LLM_DEFAULT_PROVIDER=claude-code` 时, agent LLM 客户端走 cliproxy +
 * Claude Code identity 透传路径, URL/API key 从 `LLM_PROVIDER_CLAUDE_*` 读
 * (= `config.llm.providers.claude`). 这个常量是这个 fallback 的 provider 名字,
 * 与 `CLAUDE_CODE_PROVIDER_NAME` 区分: 后者是 default provider 标识符,
 * 前者是承载 cliproxy URL/key 的实际 provider 注册项.
 */
export const CLAUDE_CODE_BASE_PROVIDER_NAME = 'claude'

const SCENARIO_NAME_MAP: Record<string, LlmScenarioKey> = {
  DESCRIBE_IMAGE: 'describeImage',
  DESCRIBE_VIDEO: 'describeVideo',
  DESCRIBE_PDF: 'describePdf',
  TRANSCRIBE_AUDIO: 'transcribeAudio',
}

const CLAUDE_THINKING_MODES: readonly ClaudeThinkingMode[] = ['disabled', 'adaptive']
const CLAUDE_THINKING_RETENTIONS: readonly ClaudeThinkingRetention[] = ['active-tool-cycle', 'always']
const CLAUDE_THINKING_LOGS: readonly ClaudeThinkingLog[] = ['off', 'summary', 'raw']
const OPENAI_REASONING_EFFORTS: readonly OpenAiReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function requireEnv(env: EnvSource, name: string): string {
  const value = env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function parseMoomooConfig(env: EnvSource): MoomooConfig | undefined {
  if (!parseBoolean(env.MOOMOO_SKILL_ENABLED, false)) return undefined
  const skillDir = env.MOOMOO_SKILL_DIR?.trim()
  if (!skillDir) throw new Error('MOOMOO_SKILL_DIR is required when MOOMOO_SKILL_ENABLED=true')
  if (!isAbsolute(skillDir)) throw new Error('MOOMOO_SKILL_DIR must be an absolute path')
  return {
    skillDir,
    pythonBin: env.MOOMOO_PYTHON_BIN?.trim() || 'python3',
    opendPort: parsePositiveInteger(env.MOOMOO_OPEND_PORT, 11_111),
    timeoutMs: parsePositiveInteger(env.MOOMOO_SKILL_TIMEOUT_MS, 15_000),
  }
}

function parseCryptoPaperConfig(env: EnvSource): CryptoPaperConfig | undefined {
  if (!parseBoolean(env.CRYPTO_PAPER_ENABLED, false)) return undefined
  const initialCash = Number(env.CRYPTO_PAPER_INITIAL_CASH?.trim() || '100000')
  const feeRateBps = Number(env.CRYPTO_PAPER_FEE_RATE_BPS?.trim() || '10')
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    throw new Error('CRYPTO_PAPER_INITIAL_CASH must be a positive number')
  }
  if (!Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
    throw new Error('CRYPTO_PAPER_FEE_RATE_BPS must be an integer between 0 and 10000')
  }
  return { initialCash, feeRateBps }
}

function parseVibeTradingConfig(env: EnvSource): VibeTradingConfig | undefined {
  if (!parseBoolean(env.VIBE_TRADING_ENABLED, false)) return undefined

  const rawBaseUrl = env.VIBE_TRADING_BASE_URL?.trim() || 'http://127.0.0.1:8899'
  let url: URL
  try {
    url = new URL(rawBaseUrl)
  } catch {
    throw new Error('VIBE_TRADING_BASE_URL must be a valid loopback HTTP URL')
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (
    url.protocol !== 'http:'
    || !loopbackHosts.has(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('VIBE_TRADING_BASE_URL must be an origin-only loopback HTTP URL')
  }

  const apiKey = env.VIBE_TRADING_API_KEY?.trim()
  return {
    baseUrl: url.origin,
    ...(apiKey ? { apiKey } : {}),
    requestTimeoutMs: parsePositiveInteger(env.VIBE_TRADING_REQUEST_TIMEOUT_MS, 15_000),
    taskTimeoutMs: parsePositiveInteger(env.VIBE_TRADING_TASK_TIMEOUT_MS, 30 * 60_000),
    pollIntervalMs: parsePositiveInteger(env.VIBE_TRADING_POLL_INTERVAL_MS, 2_000),
    resultMaxChars: parsePositiveInteger(env.VIBE_TRADING_RESULT_MAX_CHARS, 12_000),
  }
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return Math.floor(parsed)
}

function parseStrictPositiveInteger(name: string, value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${value}" (must be positive safe integer)`)
  }
  return parsed
}

function parseStrictNonNegativeInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} "${value}" (must be a non-negative safe integer)`)
  }
  return parsed
}

function parsePositiveSafeInteger(name: string, value: string): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${value}" (must be positive safe integer)`)
  }
  return parsed
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const v = value.trim().toLowerCase()
  if (v === '') return defaultValue
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return defaultValue
}

function parseClaudeToolChoice(value: string | undefined): 'any' | 'auto' {
  const normalized = value?.trim().toLowerCase() || 'any'
  if (normalized === 'any' || normalized === 'auto') return normalized
  throw new Error(
    `Invalid LLM_PROVIDER_CLAUDE_TOOL_CHOICE "${value}" (expected any or auto)`,
  )
}

function parseEnumValue<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return defaultValue
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T
  throw new Error(`Invalid ${name} "${value}" (expected ${allowed.join(' or ')})`)
}

function parseClaudeThinking(env: EnvSource): ClaudeThinkingConfig {
  return {
    mode: parseEnumValue(
      'LLM_PROVIDER_CLAUDE_THINKING',
      env.LLM_PROVIDER_CLAUDE_THINKING,
      CLAUDE_THINKING_MODES,
      'disabled',
    ),
    retention: parseEnumValue(
      'LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION',
      env.LLM_PROVIDER_CLAUDE_THINKING_PROMPT_RETENTION,
      CLAUDE_THINKING_RETENTIONS,
      'active-tool-cycle',
    ),
    log: parseEnumValue(
      'LLM_PROVIDER_CLAUDE_THINKING_LOG',
      env.LLM_PROVIDER_CLAUDE_THINKING_LOG,
      CLAUDE_THINKING_LOGS,
      'off',
    ),
  }
}

/**
 * Owner = 把 bot 做出来的那个人. 出现在 system prompt 的 [关系基线] 段里, 让 Luna
 * 知道 QQ:xxx 这个号是谁. 两个 env (QQ + 名字) 必须同时给, 单给一个 throw —— 避免
 * "知道 QQ 不知道叫什么" 或 "知道叫什么但不知道哪个号" 这种半调子状态. 都不给则
 * 返回 null, [关系基线] 段整段不渲染 (字节稳定: 无 owner 时 prompt 跟无此特性一致).
 */
export interface BotOwner {
  qq: number
  name: string
}

function parseOwner(env: EnvSource): BotOwner | null {
  const qqRaw = env.BOT_OWNER_QQ?.trim() ?? ''
  const nameRaw = env.BOT_OWNER_NAME?.trim() ?? ''
  const hasQq = qqRaw.length > 0
  const hasName = nameRaw.length > 0
  if (!hasQq && !hasName) return null
  if (hasQq !== hasName) {
    throw new Error('BOT_OWNER_QQ and BOT_OWNER_NAME must be set together (or both empty)')
  }
  const qq = parsePositiveSafeInteger('BOT_OWNER_QQ', qqRaw)
  return { qq, name: nameRaw }
}

function parseWebsiteConfig(env: EnvSource): WebsiteConfig | undefined {
  if (!parseBoolean(env.BOT_WEBSITE_ENABLED, false)) return undefined

  const repoDir = env.BOT_WEBSITE_REPO_DIR?.trim() ?? ''
  if (!repoDir) {
    throw new Error('BOT_WEBSITE_REPO_DIR is required when BOT_WEBSITE_ENABLED=true')
  }

  const publicUrl = env.BOT_WEBSITE_PUBLIC_URL?.trim()
  const branch = env.BOT_WEBSITE_BRANCH?.trim() || 'main'
  const checkCommand = env.BOT_WEBSITE_CHECK_COMMAND?.trim() || 'pnpm build'
  const commandTimeoutMs = parsePositiveInteger(env.BOT_WEBSITE_COMMAND_TIMEOUT_MS, 60_000)

  return {
    repoDir,
    ...(publicUrl ? { publicUrl } : {}),
    branch,
    checkCommand,
    commandTimeoutMs,
  }
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
  const scenarioFields = ['PROVIDER', 'MODEL', 'REASONING_EFFORT'] as const

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
    if (matchedField === 'REASONING_EFFORT') {
      scenarios[scenarioName].reasoningEffort = parseEnumValue(
        name,
        value,
        OPENAI_REASONING_EFFORTS,
        'medium',
      )
    }
  }

  return scenarios
}

function parseModelContextWindows(value: string | undefined): Record<string, number> {
  const raw = value?.trim()
  if (!raw) {
    throw new Error('Missing required environment variable: LLM_MODEL_CONTEXT_WINDOWS_JSON')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid LLM_MODEL_CONTEXT_WINDOWS_JSON (must be a JSON object)')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid LLM_MODEL_CONTEXT_WINDOWS_JSON (must be a JSON object)')
  }

  const entries = Object.entries(parsed as Record<string, unknown>)
    .map(([rawModel, tokens]) => {
      const model = rawModel.trim()
      if (!model || !Number.isSafeInteger(tokens) || (tokens as number) <= 0) {
        throw new Error(
          'Invalid LLM_MODEL_CONTEXT_WINDOWS_JSON (model names must be non-empty and values positive safe integers)',
        )
      }
      return [model, tokens as number] as const
    })
    .sort(([left], [right]) => left.localeCompare(right))

  return Object.fromEntries(entries)
}

function parseCompactionConfig(env: EnvSource) {
  return {
    reserveTokens: parseStrictPositiveInteger(
      'COMPACTION_RESERVE_TOKENS',
      env.COMPACTION_RESERVE_TOKENS,
      16_384,
    ),
    keepRecentTokens: parseStrictPositiveInteger(
      'COMPACTION_KEEP_RECENT_TOKENS',
      env.COMPACTION_KEEP_RECENT_TOKENS,
      20_000,
    ),
    failureBackoffMs: parseStrictPositiveInteger(
      'COMPACTION_FAILURE_BACKOFF_MS',
      env.COMPACTION_FAILURE_BACKOFF_MS,
      600_000,
    ),
  }
}

function parseLlmConfig(env: EnvSource) {
  const providers = parseProviderConfigs(env)
  const defaultProvider = requireEnv(env, 'LLM_DEFAULT_PROVIDER').toLowerCase()
  const defaultModel = requireEnv(env, 'LLM_DEFAULT_MODEL')
  const fallbackModel = env.LLM_FALLBACK_MODEL?.trim() || null
  const contextWindowTokensByModel = parseModelContextWindows(env.LLM_MODEL_CONTEXT_WINDOWS_JSON)
  const claudeToolChoice = parseClaudeToolChoice(env.LLM_PROVIDER_CLAUDE_TOOL_CHOICE)
  const claudeThinking = parseClaudeThinking(env)

  if (defaultProvider === CLAUDE_CODE_PROVIDER_NAME) {
    if (!providers[CLAUDE_CODE_BASE_PROVIDER_NAME]) {
      throw new Error('Missing provider configuration for LLM_DEFAULT_PROVIDER: claude-code requires claude')
    }
  } else if (defaultProvider === OPENAI_AGENT_PROVIDER_NAME) {
    if (!providers.openai) {
      throw new Error('Missing provider configuration for LLM_DEFAULT_PROVIDER: openai-agent requires openai')
    }
  } else {
    throw new Error(
      `Unsupported LLM_DEFAULT_PROVIDER: ${defaultProvider} (expected ${CLAUDE_CODE_PROVIDER_NAME} or ${OPENAI_AGENT_PROVIDER_NAME})`,
    )
  }

  const scenarios = parseScenarioConfigs(env)
  for (const [scenarioName, scenario] of Object.entries(scenarios)) {
    if (scenario.provider && !providers[scenario.provider]) {
      throw new Error(`Missing provider configuration for scenario ${scenarioName}: ${scenario.provider}`)
    }
  }

  if (contextWindowTokensByModel[defaultModel] == null) {
    throw new Error(
      `LLM_MODEL_CONTEXT_WINDOWS_JSON is missing default model ${defaultModel}`,
    )
  }
  if (fallbackModel && contextWindowTokensByModel[fallbackModel] == null) {
    throw new Error(
      `LLM_MODEL_CONTEXT_WINDOWS_JSON is missing fallback model ${fallbackModel}`,
    )
  }

  return {
    defaultProvider,
    defaultModel,
    fallbackModel,
    contextWindowTokensByModel,
    claudeToolChoice,
    claudeThinking,
    providers,
    scenarios,
  }
}

export function parseConfig(
  env: EnvSource,
  groupPoliciesInput: readonly GroupPolicy[] = [],
) {
  const groupPolicies = [...groupPoliciesInput].sort((left, right) => left.id - right.id)
  const groupIds = groupPolicies.map((policy) => policy.id)
  const compaction = parseCompactionConfig(env)
  const llm = parseLlmConfig(env)
  for (const model of [llm.defaultModel, llm.fallbackModel].filter((value): value is string => Boolean(value))) {
    const contextWindowTokens = llm.contextWindowTokensByModel[model]
    if (compaction.reserveTokens + compaction.keepRecentTokens >= contextWindowTokens) {
      throw new Error(
        `Compaction reserve plus keep must be smaller than context window for model ${model}`,
      )
    }
  }
  const redditTimeoutMs = parsePositiveInteger(env.BOT_REDDIT_TIMEOUT_MS, 8_000)
  const fetchUrlTimeoutMs = parsePositiveInteger(env.BOT_FETCH_URL_TIMEOUT_MS, 12_000)
  const fetchLogPath = env.BOT_FETCH_LOG_PATH && env.BOT_FETCH_LOG_PATH.trim().length > 0
    ? env.BOT_FETCH_LOG_PATH.trim()
    : 'logs/fetch.ndjson'
  const tokenUsageLogPath = env.BOT_TOKEN_USAGE_LOG_PATH && env.BOT_TOKEN_USAGE_LOG_PATH.trim().length > 0
    ? env.BOT_TOKEN_USAGE_LOG_PATH.trim()
    : 'logs/token-usage.ndjson'
  const toolCallLogPath = env.BOT_TOOL_CALL_LOG_PATH && env.BOT_TOOL_CALL_LOG_PATH.trim().length > 0
    ? env.BOT_TOOL_CALL_LOG_PATH.trim()
    : 'logs/tool-calls.ndjson'
  const observabilityRetentionDays = parseStrictNonNegativeInteger(
    'BOT_OBSERVABILITY_RETENTION_DAYS',
    env.BOT_OBSERVABILITY_RETENTION_DAYS,
    30,
  )
  const toolAuditMode = parseEnumValue(
    'BOT_TOOL_AUDIT_MODE',
    env.BOT_TOOL_AUDIT_MODE,
    ['off', 'side_effects', 'all'] as const,
    'side_effects',
  )
  const toolAuditDbEnabled = parseBoolean(env.BOT_TOOL_AUDIT_DB_ENABLED, false)
  const backgroundTaskStatePath = env.BOT_BACKGROUND_TASK_STATE_PATH
    && env.BOT_BACKGROUND_TASK_STATE_PATH.trim().length > 0
    ? env.BOT_BACKGROUND_TASK_STATE_PATH.trim()
    : 'data/agent-workspace/runtime/background-tasks.json'
  const scheduleStatePath = env.BOT_SCHEDULE_STATE_PATH
    && env.BOT_SCHEDULE_STATE_PATH.trim().length > 0
    ? env.BOT_SCHEDULE_STATE_PATH.trim()
    : 'data/agent-workspace/runtime/schedules.json'
  const approvalStatePath = env.BOT_APPROVAL_STATE_PATH && env.BOT_APPROVAL_STATE_PATH.trim().length > 0
    ? env.BOT_APPROVAL_STATE_PATH.trim()
    : 'data/agent-workspace/runtime/approvals.json'
  const approvalMode = parseEnumValue(
    'BOT_APPROVAL_MODE',
    env.BOT_APPROVAL_MODE,
    ['off', 'thin', 'strict'] as const,
    'thin',
  )
  const mcpConfigPath = env.BOT_MCP_CONFIG_PATH && env.BOT_MCP_CONFIG_PATH.trim().length > 0
    ? env.BOT_MCP_CONFIG_PATH.trim()
    : undefined
  const mcpSchemaSnapshotDir = env.BOT_MCP_SCHEMA_SNAPSHOT_DIR
    && env.BOT_MCP_SCHEMA_SNAPSHOT_DIR.trim().length > 0
    ? env.BOT_MCP_SCHEMA_SNAPSHOT_DIR.trim()
    : 'data/agent-workspace/runtime/mcp-schemas'
  const outboundCacheMaxEntries = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_MAX_ENTRIES, 32)
  const outboundCacheMaxBytes = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_MAX_BYTES, 100 * 1024 * 1024)
  const outboundCacheTtlMs = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_TTL_MS, 60 * 60 * 1000)
  const eventDebounceMs = parsePositiveInteger(env.BOT_EVENT_DEBOUNCE_MS, 3_000)
  const browserEnabled = parseBoolean(env.BOT_BROWSER_ENABLED, false)
  const browserControllerUrl = env.BOT_BROWSER_CONTROLLER_URL && env.BOT_BROWSER_CONTROLLER_URL.trim().length > 0
    ? env.BOT_BROWSER_CONTROLLER_URL.trim()
    : 'http://127.0.0.1:37921'
  const browserProfileDir = env.BOT_BROWSER_PROFILE_DIR && env.BOT_BROWSER_PROFILE_DIR.trim().length > 0
    ? env.BOT_BROWSER_PROFILE_DIR.trim()
    : 'data/browser-profile/luna'
  const browserArtifactDir = env.BOT_BROWSER_ARTIFACT_DIR && env.BOT_BROWSER_ARTIFACT_DIR.trim().length > 0
    ? env.BOT_BROWSER_ARTIFACT_DIR.trim()
    : 'data/agent-workspace/browser'
  const browserActionLogPath = env.BOT_BROWSER_ACTION_LOG_PATH && env.BOT_BROWSER_ACTION_LOG_PATH.trim().length > 0
    ? env.BOT_BROWSER_ACTION_LOG_PATH.trim()
    : 'logs/browser-actions.ndjson'
  const browserActionTimeoutMs = parsePositiveInteger(env.BOT_BROWSER_ACTION_TIMEOUT_MS, 15_000)

  return {
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    napcat: {
      wsUrl: requireEnv(env, 'NAPCAT_WS_URL'),
      accessToken: requireEnv(env, 'NAPCAT_ACCESS_TOKEN'),
    },
    /** 单一群策略；群号、主动发送授权、参与节奏和固定提示均来自 prompts/groups.md。 */
    groupPolicies,
    /** Derived group whitelist. 私聊不走白名单, 由 ingress 层 sub_type='friend' 过滤. */
    botTargetGroupIds: groupIds,
    selfNumber: parsePositiveSafeInteger('SELF_NUMBER', requireEnv(env, 'SELF_NUMBER')),
    /** Owner (创造者) — 渲染 [关系基线] 用. null = 未配置 → 那段不渲染. */
    owner: parseOwner(env),
    nodeEnv: env.NODE_ENV || 'development',
    replyMediaTimeoutMs: parsePositiveInteger(env.REPLY_MEDIA_TIMEOUT_MS, 15_000),
    jobInterDelayMs: parsePositiveInteger(env.JOB_INTER_DELAY_MS, 200),
    compaction,
    /** Hard timeout for reddit action=list / action=get_post (AbortController). */
    redditTimeoutMs,
    /** Hard timeout for fetch_url (AbortController). */
    fetchUrlTimeoutMs,
    /** NDJSON sidecar log path. Not a Prisma table — operations data only. */
    fetchLogPath,
    /** Token usage NDJSON log path. Override via BOT_TOKEN_USAGE_LOG_PATH env. */
    tokenUsageLogPath,
    /** Unified tool-call NDJSON sidecar log path. Override via BOT_TOOL_CALL_LOG_PATH env. */
    toolCallLogPath,
    /** Observability DB/NDJSON retention in days. Zero disables automatic cleanup. */
    observabilityRetentionDays,
    toolAuditMode,
    toolAuditDbEnabled,
    backgroundTaskStatePath,
    scheduleStatePath,
    approvalStatePath,
    approvalMode,
    mcpConfigPath,
    mcpSchemaSnapshotDir,
    /**
     * 队列有事件时, drainEvents 前等更多事件堆积的毫秒数. 合并连续消息进同一轮 LLM
     * 调用. 默认 3s 覆盖常见连续输入; 媒体 readiness 在事件入队前单独处理. 非正值或
     * 非数字 fallback 默认. 测试通过 `eventDebounceMs: 0` 直接传给 createBotLoopAgent 绕过.
     */
    eventDebounceMs,
    outboundCache: {
      maxEntries: outboundCacheMaxEntries,
      maxBytes: outboundCacheMaxBytes,
      ttlMs: outboundCacheTtlMs,
    },
    browser: {
      enabled: browserEnabled,
      controllerUrl: browserControllerUrl,
      profileDir: browserProfileDir,
      artifactDir: browserArtifactDir,
      actionLogPath: browserActionLogPath,
      actionTimeoutMs: browserActionTimeoutMs,
    },
    openbb: parseBoolean(env.OPENBB_CLI_ENABLED, false)
      ? {
          cliBin: env.OPENBB_CLI_BIN?.trim() || 'openbb',
          cliTimeoutMs: parsePositiveInteger(env.OPENBB_CLI_TIMEOUT_MS, 15_000),
        }
      : undefined,
    moomoo: parseMoomooConfig(env),
    cryptoPaper: parseCryptoPaperConfig(env),
    vibeTrading: parseVibeTradingConfig(env),
    website: parseWebsiteConfig(env),
    tavily: env.TAVILY_API_KEY
      ? { apiKey: env.TAVILY_API_KEY }
      : undefined,
    llm,
  } as const
}

export const config = parseConfig(process.env, loadGroupPolicies())
