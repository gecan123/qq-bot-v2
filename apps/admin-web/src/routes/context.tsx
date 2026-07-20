import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ContextView } from '../features/context/ContextView.js'
import { contextQueryOptions } from '../features/context/context.query.js'

export const Route = createFileRoute('/context')({ loader: ({ context }) => context.queryClient.ensureQueryData(contextQueryOptions), component: ContextPage })
function ContextPage() { const initial = Route.useLoaderData(); const query = useQuery({ ...contextQueryOptions, initialData: initial }); return <ContextView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError} /> }
