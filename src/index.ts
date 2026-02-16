import { prisma } from './database/client.js'
import { startBot } from './bot/core.js'
import { log } from './logger.js'

async function main() {
  log.info('QQ Bot V2 starting...')
  await prisma.$connect()
  log.info('Database connected')
  await startBot()
}

process.on('SIGINT', async () => {
  log.info('Shutting down...')
  await prisma.$disconnect()
  process.exit(0)
})

main().catch((err) => {
  log.fatal(err, 'Failed to start')
  process.exit(1)
})
