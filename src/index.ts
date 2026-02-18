import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { GeminiProvider, isGeminiAvailable } from './llm/gemini-adapter.js'
import { startMemoryRefreshJob } from './jobs/refresh-memory.js'

let stopMemoryJob: () => void = () => {}

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')

  if (isGeminiAvailable()) {
    setLlmProvider(new GeminiProvider())
    log.info('Gemini LLM provider registered')
  } else {
    log.warn('Gemini OAuth credentials not found, LLM features disabled')
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
