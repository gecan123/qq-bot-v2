import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { GeminiProvider, isGeminiAvailable } from './llm/gemini-adapter.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import type { LlmProvider } from './llm/types.js'
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'
import { config } from './config/index.js'

let stopMemoryJob: () => void = () => {}

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')

  const geminiAvailable = isGeminiAvailable()

  function buildProvider(providerName: 'gemini' | 'openai', model?: string): LlmProvider | null {
    if (providerName === 'openai') {
      const { baseUrl, apiKey } = config.llm.openai
      return new OpenAIProvider(baseUrl, apiKey, model ?? config.llm.openai.model)
    }
    if (geminiAvailable) {
      return new GeminiProvider(model ?? config.llm.gemini.model)
    }
    return null
  }

  const defaultProvider = buildProvider(config.llm.provider)

  if (!defaultProvider) {
    log.warn('Default LLM provider unavailable, LLM features disabled')
  } else {
    const scenarios = config.llm.scenarios
    const routes = Object.fromEntries(
      Object.entries(scenarios)
        .filter(([, s]) => s.provider || s.model)
        .map(([key, s]) => {
          const providerName = s.provider ?? config.llm.provider
          const p = buildProvider(providerName, s.model)
          return [key, p]
        })
        .filter(([, p]) => p !== null),
    ) as ConstructorParameters<typeof RoutingProvider>[1]

    const routing = new RoutingProvider(defaultProvider, routes)
    setLlmProvider(routing)
    log.info({ default: config.llm.provider, scenarios }, 'LLM routing provider registered')
  }

  jobQueue.start()
  stopMemoryJob = startMemoryRefreshJob()
  log.info('Memory refresh job started')
  await startBot()
}

async function shutdown() {
  log.info('Shutting down...')
  stopMemoryJob()
  jobQueue.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  log.fatal(err, 'Failed to start')
  process.exit(1)
})
