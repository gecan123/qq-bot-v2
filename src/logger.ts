import path from 'path'
import { fileURLToPath } from 'url'
import { pino } from 'pino'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const logFilePath = process.env.LOG_FILE_PATH ?? path.join(projectRoot, 'logs', 'app.log')
const fileLogEnabled = process.env.LOG_FILE_ENABLED !== 'false'

type TransportTarget = { target: string; options: Record<string, unknown>; level: string }
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

// sv-SE locale produces "YYYY-MM-DD HH:MM:SS" — clean and sortable
const beijingTimestamp = () =>
  `,"time":"${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}"`

const targets: TransportTarget[] = [
  {
    target: 'pino-pretty',
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: false, // timestamp is already formatted as Beijing time
      ignore: 'hostname,pid,scope',
      messageFormat: '{if scope}[{scope}] {end}{msg}',
      singleLine: true,
    },
    level: 'info',
  },
]

if (fileLogEnabled) {
  targets.push({
    target: 'pino-roll',
    options: {
      file: logFilePath,
      size: '10m',
      limit: { count: 2 },
      mkdir: true,
    },
    level: 'info',
  })
}

export const log = pino({
  level: 'info',
  timestamp: beijingTimestamp,
  transport: { targets },
})

function withScope(scope: string, args: unknown[]): unknown[] {
  const [first, ...rest] = args
  if (first != null && typeof first === 'object' && !Array.isArray(first)) {
    return [{ scope, ...(first as Record<string, unknown>) }, ...rest]
  }

  return [{ scope }, ...args]
}

export function createLogger(scope: string) {
  const call = (level: LogLevel, args: unknown[]) => {
    ;(log[level] as (...params: unknown[]) => unknown)(...withScope(scope, args))
  }

  return {
    debug: (...args: unknown[]) => call('debug', args),
    info: (...args: unknown[]) => call('info', args),
    warn: (...args: unknown[]) => call('warn', args),
    error: (...args: unknown[]) => call('error', args),
    fatal: (...args: unknown[]) => call('fatal', args),
  }
}
