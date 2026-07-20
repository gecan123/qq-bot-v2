import { queryOptions } from '@tanstack/react-query'
import { getHealthSnapshot } from './health.functions.js'

export const healthQueryOptions = queryOptions({
  queryKey: ['health', 'snapshot'] as const,
  queryFn: () => getHealthSnapshot(),
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  retry: false,
})
