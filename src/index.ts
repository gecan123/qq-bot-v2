import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'
import { jobQueue } from './queue/index.js'

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')
  jobQueue.start()
  await startBot()
}

async function shutdown() {
  log.info('Shutting down...')
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
