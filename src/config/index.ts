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

export const CLAUDE_CODE_PROVIDER_NAME = 'claude-code'

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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const v = value.trim().toLowerCase()
  if (v === '') return defaultValue
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return defaultValue
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
  const qq = Number(qqRaw)
  if (!Number.isFinite(qq) || !Number.isInteger(qq) || qq <= 0) {
    throw new Error(`Invalid BOT_OWNER_QQ "${qqRaw}" (must be positive integer)`)
  }
  return { qq, name: nameRaw }
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

  // claude-code 不在 providers 注册表里 (它复用 LLM_PROVIDER_CLAUDE_* 走 cliproxy);
  // 其它 provider 必须在注册表里能找到。
  if (defaultProvider !== CLAUDE_CODE_PROVIDER_NAME && !providers[defaultProvider]) {
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
  const groupAmbientSendIds = new Set(parseIdList('BOT_GROUP_AMBIENT_SEND_IDS', env.BOT_GROUP_AMBIENT_SEND_IDS))

  const outboundCacheMaxEntries = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_MAX_ENTRIES, 32)
  const outboundCacheMaxBytes = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_MAX_BYTES, 100 * 1024 * 1024)
  const outboundCacheTtlMs = parsePositiveInteger(env.BOT_OUTBOUND_CACHE_TTL_MS, 60 * 60 * 1000)
  const eventDebounceMs = parsePositiveInteger(env.BOT_EVENT_DEBOUNCE_MS, 3_000)
  const groupPromptsPath = env.BOT_GROUP_PROMPTS_PATH && env.BOT_GROUP_PROMPTS_PATH.trim().length > 0
    ? env.BOT_GROUP_PROMPTS_PATH.trim()
    : './prompts/groups.yaml'

  return {
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    napcat: {
      wsUrl: requireEnv(env, 'NAPCAT_WS_URL'),
      accessToken: requireEnv(env, 'NAPCAT_ACCESS_TOKEN'),
    },
    /** Group whitelist. Bot listens + replies only within these IDs. 私聊不走白名单, 由 ingress 层 sub_type='friend' 过滤. */
    botTargetGroupIds: groupIds,
    selfNumber: Number(requireEnv(env, 'SELF_NUMBER')),
    /** Owner (创造者) — 渲染 [关系基线] 用. null = 未配置 → 那段不渲染. */
    owner: parseOwner(env),
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
    /** Hard timeout for list_reddit / get_reddit_post (AbortController). */
    redditTimeoutMs,
    /** Hard timeout for fetch_url (AbortController). */
    fetchUrlTimeoutMs,
    /** NDJSON sidecar log path. Not a Prisma table — operations data only. */
    fetchLogPath,
    /** Token usage NDJSON log path. Override via BOT_TOKEN_USAGE_LOG_PATH env. */
    tokenUsageLogPath,
    /** Unified tool-call NDJSON sidecar log path. Override via BOT_TOOL_CALL_LOG_PATH env. */
    toolCallLogPath,
    /**
     * 主动发言（group-ambient）白名单. 只有在此集合内的群才真发 ambient 消息,
     * 不在集合内的群走 dry-run (对 LLM 返回假成功, 群友感知不到).
     * Reply / private 路径不受影响. 空集合 = 全部 dry-run (安全默认值).
     * env: `BOT_GROUP_AMBIENT_SEND_IDS=111,222`
     */
    groupAmbientSendIds,
    /**
     * Per-group prompt customization yaml 路径. 启动时一次 load, 拼进 system prompt
     * `[群定制]` 段. 改这个文件需要重启 bot (红线 5: prompt cache 整段失效一次).
     * 默认 `./prompts/groups.yaml`. 文件不存在 → loader 返空数组 = 所有群走默认人设
     * (groups.yaml 含真实群号, 不入 git; 模板见 prompts/groups.yaml.example).
     */
    botGroupPromptsPath: groupPromptsPath,
    /**
     * 队列有事件时, drainEvents 前等更多事件堆积的毫秒数. 合并连续消息进同一轮 LLM
     * 调用. 默认 15s 覆盖图片描述延迟 (~10s) + 用户打字间隔. 非正值或非数字 fallback
     * 默认. 测试通过 `eventDebounceMs: 0` 直接传给 createBotLoopAgent 绕过.
     */
    eventDebounceMs,
    outboundCache: {
      maxEntries: outboundCacheMaxEntries,
      maxBytes: outboundCacheMaxBytes,
      ttlMs: outboundCacheTtlMs,
    },
    openbb: env.OPENBB_API_URL
      ? { apiUrl: env.OPENBB_API_URL.trim() }
      : undefined,
    tavily: env.TAVILY_API_KEY
      ? { apiKey: env.TAVILY_API_KEY }
      : undefined,
    llm: parseLlmConfig(env),
  } as const
}

export const config = parseConfig(process.env)
