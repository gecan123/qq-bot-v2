import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TimelineView } from '../features/timeline/TimelineView.js'
import { timelineQueryOptions } from '../features/timeline/timeline.query.js'
export const Route = createFileRoute('/timeline')({ loader: ({ context }) => context.queryClient.ensureQueryData(timelineQueryOptions), component: TimelinePage })
function TimelinePage() { const initial = Route.useLoaderData(); const query = useQuery({ ...timelineQueryOptions, initialData: initial }); return <TimelineView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/> }
