import path from 'path'
import { fileURLToPath } from 'url'
import { pino } from 'pino'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const logFilePath = process.env.LOG_FILE_PATH ?? path.join(projectRoot, 'logs', 'app.log')
const fileLogEnabled = process.env.LOG_FILE_ENABLED !== 'false'

type TransportTarget = { target: string; options: Record<string, unknown>; level: string }

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
      ignore: 'hostname,pid',
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
