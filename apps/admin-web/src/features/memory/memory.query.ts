import { queryOptions } from '@tanstack/react-query'
import { getMemoryFile, getMemorySnapshot } from './memory.functions.js'
export const memoryQueryOptions = queryOptions({ queryKey: ['memory', 'snapshot'] as const, queryFn: () => getMemorySnapshot(), refetchInterval: 30_000, refetchIntervalInBackground: false, retry: false })
export const memoryFileQueryOptions = (fileId: string) => queryOptions({ queryKey: ['memory', 'file', fileId] as const, queryFn: () => getMemoryFile({ data: { fileId } }), staleTime: 30_000, retry: false })
