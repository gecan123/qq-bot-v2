import { queryOptions } from '@tanstack/react-query'
import { getMetricsSnapshot } from './metrics.functions.js'
export const metricsQueryOptions = queryOptions({ queryKey: ['metrics', 'snapshot'] as const, queryFn: () => getMetricsSnapshot(), refetchInterval: 30_000, refetchIntervalInBackground: false, retry: false })
