import { queryOptions } from '@tanstack/react-query'
import { getOperationRun, getOperationsSnapshot } from './operations.functions.js'

export const operationsQueryOptions = queryOptions({
  queryKey: ['operations'] as const,
  queryFn: () => getOperationsSnapshot(),
  staleTime: 0,
  refetchInterval(query) {
    const status = query.state.data?.activeRun?.status
    return status === 'queued' || status === 'running' ? 1_000 : 10_000
  },
  refetchIntervalInBackground: false,
  retry: false,
})

export const operationRunQueryOptions = (runId: string) => queryOptions({
  queryKey: ['operations', 'run', runId] as const,
  queryFn: () => getOperationRun({ data: { runId } }),
  staleTime: 0,
  refetchInterval(query) {
    const status = query.state.data?.status
    return status === 'queued' || status === 'running' ? 1_000 : false
  },
  refetchIntervalInBackground: false,
  retry: false,
})
