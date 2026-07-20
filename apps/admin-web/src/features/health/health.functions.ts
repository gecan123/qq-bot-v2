import { createServerFn } from '@tanstack/react-start'
import { loadHealthSnapshot } from './health.server.js'

export const getHealthSnapshot = createServerFn({ method: 'GET' }).handler(() => loadHealthSnapshot())
