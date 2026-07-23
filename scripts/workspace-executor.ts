import { createLocalWorkspaceCommandRunner } from '../src/agent/tools/workspace-bash.js'
import { startWorkspaceExecutorServer } from '../src/executor/server.js'
import { createLogger } from '../src/logger.js'

const log = createLogger('WORKSPACE_EXECUTOR')
const executorUrl = process.env.BOT_WORKSPACE_EXECUTOR_URL?.trim() || 'http://127.0.0.1:37922'
const url = new URL(executorUrl)
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
  throw new Error('BOT_WORKSPACE_EXECUTOR_URL must be a loopback HTTP URL')
}

const host = url.hostname === '[::1]' ? '::1' : url.hostname
const port = Number(url.port || '37922')
const workspaceDir = process.env.BOT_WORKSPACE_EXECUTOR_WORKSPACE_DIR?.trim() || 'data/agent-workspace'
const token = process.env.BOT_WORKSPACE_EXECUTOR_TOKEN?.trim() || undefined
const maxTimeoutMs = parsePositiveInteger(process.env.BOT_WORKSPACE_EXECUTOR_MAX_TIMEOUT_MS, 5_000)
const maxOutputChars = parsePositiveInteger(process.env.BOT_WORKSPACE_EXECUTOR_MAX_OUTPUT_CHARS, 4_000)

const runner = createLocalWorkspaceCommandRunner({
  workspaceDir,
  repoDir: process.cwd(),
  maxTimeoutMs,
  maxOutputChars,
})
const server = await startWorkspaceExecutorServer({
  host,
  port,
  runner,
  ...(token ? { token } : {}),
})
log.info({ host, port, workspaceDir, maxTimeoutMs, maxOutputChars }, 'workspace_executor_started')

function shutdown(): void {
  log.info('workspace_executor_shutdown_requested')
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value?.trim()) return defaultValue
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
}
