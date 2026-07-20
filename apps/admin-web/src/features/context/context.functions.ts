import { createServerFn } from '@tanstack/react-start'
import { loadContextSnapshot } from './context.server.js'

export const getContextSnapshot = createServerFn({ method: 'GET' }).handler(() => loadContextSnapshot())
