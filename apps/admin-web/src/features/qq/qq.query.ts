import { queryOptions } from '@tanstack/react-query'
import { getQqGroupSnapshot, getQqSnapshot } from './qq.functions.js'
export const qqQueryOptions = queryOptions({ queryKey: ['qq', 'snapshot'] as const, queryFn: () => getQqSnapshot(), refetchInterval: 10_000, refetchIntervalInBackground: false, retry: false })
export const qqGroupQueryOptions = (groupId: string) => queryOptions({ queryKey: ['qq', 'group', groupId] as const, queryFn: () => getQqGroupSnapshot({ data: { groupId } }), refetchInterval: 10_000, refetchIntervalInBackground: false, retry: false })
