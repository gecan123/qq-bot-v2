import { queryOptions } from '@tanstack/react-query'
import { getTimelineSnapshot } from './timeline.functions.js'
export const timelineQueryOptions = queryOptions({ queryKey: ['timeline', 'snapshot'] as const, queryFn: () => getTimelineSnapshot(), refetchInterval: 8_000, refetchIntervalInBackground: false, retry: false })
