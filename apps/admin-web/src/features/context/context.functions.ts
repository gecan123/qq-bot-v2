import { createServerFn } from '@tanstack/react-start'
import { contextThinkingBlockInputSchema } from './context.schema.js'
import {
  loadContextSnapshot,
  loadContextThinkingArchive,
  loadContextThinkingBlock,
} from './context.server.js'

export const getContextSnapshot = createServerFn({ method: 'GET' }).handler(() => loadContextSnapshot())
export const getContextThinkingArchive = createServerFn({ method: 'GET' })
  .handler(() => loadContextThinkingArchive())
export const getContextThinkingBlock = createServerFn({ method: 'GET' })
  .validator(contextThinkingBlockInputSchema)
  .handler(({ data }) => loadContextThinkingBlock(data))
