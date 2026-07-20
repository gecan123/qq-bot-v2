import { createServerFn } from '@tanstack/react-start'
import { loadMetricsSnapshot } from './metrics.server.js'
export const getMetricsSnapshot = createServerFn({ method: 'GET' }).handler(() => loadMetricsSnapshot())
