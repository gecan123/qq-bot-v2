import { queryOptions } from '@tanstack/react-query'
import { getProcessLogSnapshot } from './logs.functions.js'
import type { ProcessLogSource } from './logs.js'

export const processLogsQueryOptions = (source: ProcessLogSource) => queryOptions({
  queryKey: ['process-logs', source] as const,
  queryFn: () => getProcessLogSnapshot({ data: source }),
  retry: false,
})
