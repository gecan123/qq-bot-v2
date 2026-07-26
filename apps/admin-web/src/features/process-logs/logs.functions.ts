import { createServerFn } from '@tanstack/react-start'
import { processLogSourceSchema } from './logs.js'
import { loadProcessLogSnapshot } from './logs.server.js'

export const getProcessLogSnapshot = createServerFn({ method: 'GET' })
  .validator(processLogSourceSchema)
  .handler(({ data }) => loadProcessLogSnapshot(data))
