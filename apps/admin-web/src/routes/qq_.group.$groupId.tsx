import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { QqGroupView } from '../features/qq/QqGroupView.js'
import { qqGroupQueryOptions } from '../features/qq/qq.query.js'

export const Route = createFileRoute('/qq_/group/$groupId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(qqGroupQueryOptions(params.groupId)),
  component: QqGroupPage,
})

function QqGroupPage() {
  const { groupId } = Route.useParams()
  const initial = Route.useLoaderData()
  const query = useQuery({ ...qqGroupQueryOptions(groupId), initialData: initial })
  return <QqGroupView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/>
}
