import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MemoryFileView } from '../features/memory/MemoryFileView.js'
import { memoryFileQueryOptions } from '../features/memory/memory.query.js'

export const Route = createFileRoute('/memory_/$fileId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(memoryFileQueryOptions(params.fileId)),
  component: MemoryFilePage,
})

function MemoryFilePage() {
  const { fileId } = Route.useParams()
  const initial = Route.useLoaderData()
  const query = useQuery({ ...memoryFileQueryOptions(fileId), initialData: initial })
  return <MemoryFileView snapshot={query.data} isRefreshing={query.isFetching} refreshFailed={query.isError}/>
}
