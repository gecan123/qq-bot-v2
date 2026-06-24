import { BrowserController } from '../src/browser/controller.js'
import { startBrowserServer } from '../src/browser/server.js'
import { createLogger } from '../src/logger.js'

const log = createLogger('BROWSER_CONTROLLER')

const controllerUrl = process.env.BOT_BROWSER_CONTROLLER_URL?.trim() || 'http://127.0.0.1:37921'
const profileDir = process.env.BOT_BROWSER_PROFILE_DIR?.trim() || 'data/browser-profile/luna'
const artifactDir = process.env.BOT_BROWSER_ARTIFACT_DIR?.trim() || 'data/agent-workspace/browser'
const actionLogPath = process.env.BOT_BROWSER_ACTION_LOG_PATH?.trim() || 'logs/browser-actions.ndjson'
const actionTimeoutMs = parsePositiveInteger(process.env.BOT_BROWSER_ACTION_TIMEOUT_MS, 15_000)
const headless = parseOptionalBoolean(process.env.BOT_BROWSER_HEADLESS)
const humanize = parseOptionalBoolean(process.env.BOT_BROWSER_HUMANIZE)
const humanPreset = parseHumanPreset(process.env.BOT_BROWSER_HUMAN_PRESET)
const proxy = parseOptionalString(process.env.BOT_BROWSER_PROXY)
const geoip = parseOptionalBoolean(process.env.BOT_BROWSER_GEOIP)
const timezone = parseOptionalString(process.env.BOT_BROWSER_TIMEZONE)
const locale = parseOptionalString(process.env.BOT_BROWSER_LOCALE)
const extensionPaths = parseCsv(process.env.BOT_BROWSER_EXTENSION_PATHS)
const args = parseCsv(process.env.BOT_BROWSER_ARGS)

const url = new URL(controllerUrl)
const host = url.hostname || '127.0.0.1'
const port = Number(url.port || '37921')

const controller = new BrowserController({
  profileDir,
  artifactDir,
  actionLogPath,
  actionTimeoutMs,
  ...(headless != null ? { headless } : {}),
  ...(humanize != null ? { humanize } : {}),
  ...(humanPreset ? { humanPreset } : {}),
  ...(proxy ? { proxy } : {}),
  ...(geoip != null ? { geoip } : {}),
  ...(timezone ? { timezone } : {}),
  ...(locale ? { locale } : {}),
  ...(extensionPaths.length ? { extensionPaths } : {}),
  ...(args.length ? { args } : {}),
})

const server = await startBrowserServer({ host, port, controller })
log.info({ host, port, profileDir }, 'browser_controller_started')

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

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return Math.floor(parsed)
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return undefined
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  return undefined
}

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function parseCsv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function parseHumanPreset(value: string | undefined): 'default' | 'careful' | undefined {
  const normalized = value?.trim()
  if (normalized === 'default' || normalized === 'careful') return normalized
  return undefined
}
