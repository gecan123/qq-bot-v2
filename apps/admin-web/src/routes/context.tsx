import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ContextView } from '../features/context/ContextView.js'
import { contextQueryOptions } from '../features/context/context.query.js'
import type { ContextSnapshot } from '../features/context/context.schema.js'

type ContextSearch = { demo: boolean }

export const Route = createFileRoute('/context')({
  validateSearch: (search: Record<string, unknown>): ContextSearch => ({
    demo: search.demo === 1 || search.demo === '1' || search.demo === 'true' || search.demo === true,
  }),
  loaderDeps: ({ search }) => ({ demo: search.demo }),
  loader: async ({ context, deps }) => deps.demo
    ? (await import('../features/context/context.demo.js')).contextDemoSnapshot
    : context.queryClient.ensureQueryData(contextQueryOptions),
  component: ContextPage,
})

function ContextPage() {
  const { demo } = Route.useSearch()
  const initial = Route.useLoaderData()
  if (demo) return <ContextView snapshot={initial} isRefreshing={false} refreshFailed={false} isDemo />
  return <LiveContextPage initial={initial} />
}

function LiveContextPage({ initial }: { initial: ContextSnapshot }) {
  const query = useQuery({ ...contextQueryOptions, initialData: initial })
  return <ContextView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError} />
}
