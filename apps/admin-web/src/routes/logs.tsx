import { createFileRoute } from '@tanstack/react-router'
import { LogsView } from '../features/process-logs/LogsView.js'
import { processLogsQueryOptions } from '../features/process-logs/logs.query.js'

const DEFAULT_SOURCE = 'agent-core' as const

export const Route = createFileRoute('/logs')({
  loader: ({ context }) => context.queryClient.ensureQueryData(processLogsQueryOptions(DEFAULT_SOURCE)),
  component: LogsPage,
})

function LogsPage() {
  return <LogsView initialSnapshot={Route.useLoaderData()} />
}
