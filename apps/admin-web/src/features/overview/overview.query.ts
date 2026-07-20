import { queryOptions } from '@tanstack/react-query'
import { getOverviewSnapshot } from './overview.functions.js'

export const overviewQueryOptions = queryOptions({
  queryKey: ['overview', 'snapshot'] as const,
  queryFn: () => getOverviewSnapshot(),
  staleTime: 0,
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
  retry: false,
})
