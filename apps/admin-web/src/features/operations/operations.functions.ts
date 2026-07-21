import { createServerFn } from '@tanstack/react-start'
import {
  operationRequestSchema,
  operationRunIdRequestSchema,
  operationStartRequestSchema,
} from './operations.schema.js'
import {
  createOperationPreviewServer,
  getOperationRunServer,
  loadOperationsSnapshot,
  startOperationServer,
} from './operations.server.js'

export const getOperationsSnapshot = createServerFn({ method: 'GET' })
  .handler(() => loadOperationsSnapshot())

export const createOperationPreview = createServerFn({ method: 'POST' })
  .validator(operationRequestSchema)
  .handler(({ data }) => createOperationPreviewServer(data))

export const startOperation = createServerFn({ method: 'POST' })
  .validator(operationStartRequestSchema)
  .handler(({ data }) => startOperationServer(data))

export const getOperationRun = createServerFn({ method: 'GET' })
  .validator(operationRunIdRequestSchema)
  .handler(({ data }) => getOperationRunServer(data))
