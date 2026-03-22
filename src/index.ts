import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'
import { config } from './config/index.js'

let stopMemoryJob: () => void = () => {}

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')

  const { baseUrl, apiKey, model, scenarios } = config.llm
  const defaultProvider = new OpenAIProvider(baseUrl, apiKey, model)

  const routes = Object.fromEntries(
    Object.entries(scenarios)
      .filter(([, s]) => s.baseUrl || s.apiKey || s.model)
      .map(([key, s]) => [
        key,
        new OpenAIProvider(s.baseUrl ?? baseUrl, s.apiKey ?? apiKey, s.model ?? model),
      ]),
  ) as ConstructorParameters<typeof RoutingProvider>[1]

  const routing = new RoutingProvider(defaultProvider, routes)
  setLlmProvider(routing)
  log.info(
    {
      default: model,
      scenarios: Object.fromEntries(
        Object.entries(scenarios)
          .filter(([, s]) => s.model)
          .map(([key, s]) => [key, { model: s.model }]),
      ),
    },
    'LLM routing provider registered',
  )

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
