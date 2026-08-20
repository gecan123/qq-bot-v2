import 'dotenv/config'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { resolve } from 'node:path'

interface ServiceSpec {
  name: string
  sourceEntry?: string
  distEntry?: string
  healthUrl?: string
  optional?: boolean
  command?: string
  commandArgs?: string[]
}

const watch = process.argv.includes('--watch')
const includeWebAdmin = process.argv.includes('--web')
const compiled = import.meta.url.includes('/dist/platform.js')
const root = process.cwd()
const logDir = resolve(root, 'logs/processes')
const WEB_ADMIN_URL = 'http://127.0.0.1:20030/'
mkdirSync(logDir, { recursive: true })

const env: NodeJS.ProcessEnv = {
  ...process.env,
  BOT_PLATFORM_ENABLED: 'true',
}
const healthUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/health`
const webAdminLaunch = packageManagerLaunch(['--filter', '@qq-bot/admin-web', 'dev'])
const specs: ServiceSpec[] = [
  {
    name: 'llm-gateway',
    sourceEntry: 'src/services/llm-gateway.ts',
    distEntry: 'dist/services/llm-gateway.js',
    healthUrl: healthUrl(env.BOT_LLM_GATEWAY_URL ?? 'http://127.0.0.1:37926'),
  },
  {
    name: 'media-worker',
    sourceEntry: 'src/services/media-worker.ts',
    distEntry: 'dist/services/media-worker.js',
    healthUrl: healthUrl(env.BOT_MEDIA_WORKER_URL ?? 'http://127.0.0.1:37923'),
  },
  {
    name: 'scheduler',
    sourceEntry: 'src/services/scheduler.ts',
    distEntry: 'dist/services/scheduler.js',
    healthUrl: healthUrl(env.BOT_SCHEDULER_URL ?? 'http://127.0.0.1:37924'),
  },
  {
    name: 'qq-gateway',
    sourceEntry: 'src/services/qq-gateway.ts',
    distEntry: 'dist/services/qq-gateway.js',
    healthUrl: healthUrl(env.BOT_QQ_GATEWAY_URL ?? 'http://127.0.0.1:37922'),
  },
  {
    name: 'browser-controller',
    sourceEntry: 'scripts/browser-controller.ts',
    healthUrl: healthUrl(env.BOT_BROWSER_CONTROLLER_URL ?? 'http://127.0.0.1:37921'),
    optional: !enabled(env.BOT_BROWSER_ENABLED),
  },
  ...(includeWebAdmin ? [{
    name: 'web-admin',
    healthUrl: WEB_ADMIN_URL,
    ...webAdminLaunch,
  }] : []),
]

const children = new Map<string, ChildProcess>()
const logFds: number[] = []
let stopping = false
let finishPlatform: () => void = () => undefined
const platformDone = new Promise<void>((resolvePromise) => {
  finishPlatform = resolvePromise
})

process.once('SIGINT', () => void shutdown('SIGINT').then(finishPlatform))
process.once('SIGTERM', () => void shutdown('SIGTERM').then(finishPlatform))

try {
  for (const spec of specs.filter((item) => !item.optional)) start(spec)
  await Promise.race([
    Promise.all(specs.filter((item) => !item.optional && item.healthUrl).map(waitForHealth)),
    platformDone,
  ])
  if (!stopping) {
    start({ name: 'agent-core', sourceEntry: 'src/index.ts', distEntry: 'dist/index.js' })
    process.stdout.write(
      `[platform] started ${[...children.keys()].join(', ')}; logs: ${logDir}\n`,
    )
    if (includeWebAdmin) process.stdout.write(`[platform] WebAdmin: ${WEB_ADMIN_URL}\n`)
  }
} catch (error) {
  process.stderr.write(`[platform] startup failed: ${String(error)}\n`)
  process.exitCode = 1
  await shutdown('SIGTERM')
  finishPlatform()
}

await platformDone

function start(spec: ServiceSpec): void {
  const logPath = resolve(logDir, `${spec.name}.log`)
  const logFd = openSync(logPath, 'a')
  logFds.push(logFd)
  const useCompiledEntry = !spec.command && compiled && spec.distEntry != null
  const command = spec.command ?? process.execPath
  const args = spec.commandArgs ?? (useCompiledEntry
    ? [spec.distEntry!]
    : [...(watch ? ['--watch'] : []), '--import', 'tsx', requiredSourceEntry(spec)])
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  children.set(spec.name, child)
  child.once('exit', (code, signal) => {
    children.delete(spec.name)
    if (stopping) return
    process.stderr.write(
      `[platform] ${spec.name} exited unexpectedly (code=${String(code)}, signal=${String(signal)}); see ${logPath}\n`,
    )
    void shutdown('SIGTERM').then(() => {
      process.exitCode = code && code !== 0 ? code : 1
      finishPlatform()
    })
  })
}

async function waitForHealth(spec: ServiceSpec): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (stopping) return
    try {
      const response = await fetch(spec.healthUrl!, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  await shutdown('SIGTERM')
  throw new Error(`${spec.name} did not become healthy: ${String(lastError)}`)
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  process.stdout.write(`[platform] ${signal} received; stopping services\n`)
  for (const child of children.values()) child.kill('SIGTERM')
  await Promise.all([...children.values()].map((child) => (
    new Promise<void>((resolvePromise) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolvePromise()
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  )))
  for (const fd of logFds) {
    try {
      closeSync(fd)
    } catch {
      // best effort during shutdown
    }
  }
}

function enabled(value: string | undefined): boolean {
  return value != null && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function requiredSourceEntry(spec: ServiceSpec): string {
  if (!spec.sourceEntry) throw new Error(`${spec.name} is missing sourceEntry`)
  return spec.sourceEntry
}

function packageManagerLaunch(commandArgs: string[]): Pick<ServiceSpec, 'command' | 'commandArgs'> {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) {
    return { command: process.execPath, commandArgs: [npmExecPath, ...commandArgs] }
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    commandArgs,
  }
}
