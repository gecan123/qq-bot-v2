import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { HealthView } from '../features/health/HealthView.js'
import { healthQueryOptions } from '../features/health/health.query.js'

export const Route = createFileRoute('/health')({
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQueryOptions),
  component: HealthPage,
})

function HealthPage() {
  const initial = Route.useLoaderData()
  const query = useQuery({ ...healthQueryOptions, initialData: initial })
  return <HealthView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError} />
}
