import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LifeView } from '../features/life/LifeView.js'
import { lifeQueryOptions } from '../features/life/life.query.js'
export const Route = createFileRoute('/life')({ loader: ({ context }) => context.queryClient.ensureQueryData(lifeQueryOptions), component: LifePage })
function LifePage() { const initial = Route.useLoaderData(); const query = useQuery({ ...lifeQueryOptions, initialData: initial }); return <LifeView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/> }
