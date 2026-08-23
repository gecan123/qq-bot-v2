import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { HealthView } from '../features/health/HealthView.js'
import { healthQueryOptions } from '../features/health/health.query.js'
import { runDeepHealthCheck } from '../features/health/health.functions.js'

export const Route = createFileRoute('/health')({
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQueryOptions),
  component: HealthPage,
})

function HealthPage() {
  const initial = Route.useLoaderData()
  const queryClient = useQueryClient()
  const query = useQuery({ ...healthQueryOptions, initialData: initial })
  const deepCheck = useMutation({
    mutationFn: () => runDeepHealthCheck(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: healthQueryOptions.queryKey }),
  })
  return <HealthView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError} isDeepChecking={deepCheck.isPending} onDeepCheck={() => deepCheck.mutate()} />
}
