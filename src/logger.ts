import { pino } from 'pino'

export const log = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'hostname,pid',
    },
  },
  level: 'info',
})
