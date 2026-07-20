import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MetricsView } from '../features/metrics/MetricsView.js'
import { metricsQueryOptions } from '../features/metrics/metrics.query.js'
export const Route = createFileRoute('/metrics')({ loader: ({ context }) => context.queryClient.ensureQueryData(metricsQueryOptions), component: MetricsPage })
function MetricsPage() { const initial = Route.useLoaderData(); const query = useQuery({ ...metricsQueryOptions, initialData: initial }); return <MetricsView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/> }
