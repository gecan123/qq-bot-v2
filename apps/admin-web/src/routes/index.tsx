import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { OverviewView } from '../features/overview/OverviewView.js'
import { overviewQueryOptions } from '../features/overview/overview.query.js'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQueryOptions),
  component: OverviewPage,
})

function OverviewPage() {
  const initial = Route.useLoaderData()
  const query = useQuery({ ...overviewQueryOptions, initialData: initial })
  return (
    <OverviewView
      snapshot={query.data}
      isRefreshing={query.isFetching}
      refreshFailed={query.isError}
    />
  )
}
