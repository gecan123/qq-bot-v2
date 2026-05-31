import { config } from '../src/config/index.js'
import { BrowserController } from '../src/browser/controller.js'
import { startBrowserServer } from '../src/browser/server.js'
import { createLogger } from '../src/logger.js'

const log = createLogger('BROWSER_CONTROLLER')

const url = new URL(config.browser.controllerUrl)
const host = url.hostname || '127.0.0.1'
const port = Number(url.port || '37921')

const controller = new BrowserController({
  profileDir: config.browser.profileDir,
  artifactDir: config.browser.artifactDir,
  actionLogPath: config.browser.actionLogPath,
  actionTimeoutMs: config.browser.actionTimeoutMs,
})

const server = await startBrowserServer({ host, port, controller })
log.info({ host, port, profileDir: config.browser.profileDir }, 'browser_controller_started')

async function shutdown(): Promise<void> {
  log.info('browser_controller_shutdown_requested')
  server.close()
  await controller.close()
}

process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(0))
})
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0))
})
