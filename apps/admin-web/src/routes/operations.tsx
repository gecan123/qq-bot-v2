import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { OperationsView } from '../features/operations/OperationsView.js'
import {
  createOperationPreview,
  startOperation,
} from '../features/operations/operations.functions.js'
import {
  operationRunQueryOptions,
  operationsQueryOptions,
} from '../features/operations/operations.query.js'
import type {
  OperationPreview,
  OperationRequest,
  OperationStartRequest,
} from '../features/operations/operations.schema.js'

export const Route = createFileRoute('/operations')({
  loader: ({ context }) => context.queryClient.ensureQueryData(operationsQueryOptions),
  component: OperationsPage,
})

function OperationsPage() {
  const initial = Route.useLoaderData()
  const queryClient = useQueryClient()
  const snapshotQuery = useQuery({ ...operationsQueryOptions, initialData: initial })
  const [preview, setPreview] = useState<OperationPreview | null>(null)
  const [runId, setRunId] = useState<string | null>(initial.activeRun?.id ?? null)
  const [error, setError] = useState<string | null>(null)
  const previewMutation = useMutation({
    mutationFn: (request: OperationRequest) => createOperationPreview({ data: request }),
    onSuccess(value) {
      setPreview(value)
      setError(null)
    },
    onError(value) { setError(errorMessage(value)) },
  })
  const startMutation = useMutation({
    mutationFn: (input: OperationStartRequest) => startOperation({ data: input }),
    async onSuccess(value) {
      setRunId(value.id)
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['operations'] })
    },
    onError(value) { setError(errorMessage(value)) },
  })
  const runQuery = useQuery({
    ...operationRunQueryOptions(runId ?? 'disabled'),
    enabled: runId !== null,
  })

  useEffect(() => {
    const status = runQuery.data?.status
    if (status && !['queued', 'running'].includes(status)) {
      void queryClient.invalidateQueries({ queryKey: ['operations'] })
    }
  }, [queryClient, runQuery.data?.status])

  return <OperationsView
    snapshot={snapshotQuery.data}
    preview={preview}
    run={runQuery.data ?? null}
    isRefreshing={snapshotQuery.isFetching || runQuery.isFetching}
    isPreviewing={previewMutation.isPending}
    isStarting={startMutation.isPending}
    error={error ?? (runQuery.error ? errorMessage(runQuery.error) : null)}
    onPreview={request => previewMutation.mutateAsync(request).then(() => undefined)}
    onExecute={input => startMutation.mutateAsync(input).then(() => undefined)}
  />
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
