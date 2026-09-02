import { queryOptions } from '@tanstack/react-query'
import { getContextSnapshot } from './context.functions.js'

export const contextQueryOptions = queryOptions({
  queryKey: ['context', 'snapshot'] as const,
  queryFn: () => getContextSnapshot(),
  refetchInterval: 2_000,
  refetchIntervalInBackground: false,
  retry: false,
})
