import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { QqView } from '../features/qq/QqView.js'
import { qqQueryOptions } from '../features/qq/qq.query.js'
export const Route = createFileRoute('/qq')({ loader: ({ context }) => context.queryClient.ensureQueryData(qqQueryOptions), component: QqPage })
function QqPage() { const initial = Route.useLoaderData(); const query = useQuery({ ...qqQueryOptions, initialData: initial }); return <QqView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/> }
