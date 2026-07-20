import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MemoryView } from '../features/memory/MemoryView.js'
import { memoryQueryOptions } from '../features/memory/memory.query.js'
export const Route = createFileRoute('/memory')({ loader: ({ context }) => context.queryClient.ensureQueryData(memoryQueryOptions), component: MemoryPage })
function MemoryPage() { const initial = Route.useLoaderData(); const query = useQuery({ ...memoryQueryOptions, initialData: initial }); return <MemoryView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/> }
