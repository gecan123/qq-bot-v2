import { queryOptions } from '@tanstack/react-query'
import { getLifeSnapshot } from './life.functions.js'
export const lifeQueryOptions = queryOptions({ queryKey: ['life', 'snapshot'] as const, queryFn: () => getLifeSnapshot(), refetchInterval: 10_000, refetchIntervalInBackground: false, retry: false })
