import { OpenAIProvider } from './openai-adapter.js'
import { RoutingProvider, type RoutingScenario } from './routing-provider.js'
import type { OpenAiReasoningEffort } from '../config/index.js'

interface MediaProviderConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, { url: string; apiKey: string }>
  scenarios: Partial<Record<RoutingScenario, {
    provider?: string
    model?: string
    reasoningEffort?: OpenAiReasoningEffort
  }>>
}

const CLAUDE_CODE_PROVIDER_NAME = 'claude-code'
const OPENAI_AGENT_PROVIDER_NAME = 'openai-agent'
const OPENAI_AGENT_BASE_PROVIDER_NAME = 'openai'

export function buildMediaProvider(llm: MediaProviderConfig): RoutingProvider {
  const { defaultProvider: defaultProviderName, defaultModel, providers, scenarios } = llm
  let mediaDefaultName = defaultProviderName

  if (defaultProviderName === OPENAI_AGENT_PROVIDER_NAME) {
    mediaDefaultName = OPENAI_AGENT_BASE_PROVIDER_NAME
  } else if (defaultProviderName === CLAUDE_CODE_PROVIDER_NAME) {
    const candidates = Object.keys(providers).sort()
    if (candidates.length === 0) {
      throw new Error(
        'LLM_DEFAULT_PROVIDER=claude-code 时, 媒体路径仍需要至少一个 LLM_PROVIDER_<NAME>_URL/_API_KEY',
      )
    }
    mediaDefaultName = candidates[0]!
  }

  const defaultProviderConfig = providers[mediaDefaultName]
  if (!defaultProviderConfig) throw new Error(`Default LLM provider not found: ${mediaDefaultName}`)
  const defaultProvider = new OpenAIProvider(
    defaultProviderConfig.url,
    defaultProviderConfig.apiKey,
    defaultModel,
  )

  const routes: ConstructorParameters<typeof RoutingProvider>[1] = {}
  for (const [key, scenario] of Object.entries(scenarios) as Array<[
    RoutingScenario,
    NonNullable<MediaProviderConfig['scenarios'][RoutingScenario]>,
  ]>) {
    if (!scenario.provider && !scenario.model && !scenario.reasoningEffort) continue
    const providerName = scenario.provider ?? mediaDefaultName
    const providerConfig = providers[providerName]
    if (!providerConfig) throw new Error(`LLM scenario ${key} references unknown provider: ${providerName}`)
    routes[key] = new OpenAIProvider(
      providerConfig.url,
      providerConfig.apiKey,
      scenario.model ?? defaultModel,
      { reasoningEffort: scenario.reasoningEffort },
    )
  }

  return new RoutingProvider(defaultProvider, routes)
}
