import { createServerFn } from '@tanstack/react-start'
import { loadHealthSnapshot, runDeepLedgerHealthCheck } from './health.server.js'

export const getHealthSnapshot = createServerFn({ method: 'GET' }).handler(() => loadHealthSnapshot())
export const runDeepHealthCheck = createServerFn({ method: 'POST' }).handler(() => runDeepLedgerHealthCheck())
