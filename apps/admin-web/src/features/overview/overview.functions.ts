import { createServerFn } from '@tanstack/react-start'
import { loadOverviewServerSnapshot } from './overview.server.js'

export const getOverviewSnapshot = createServerFn({ method: 'GET' }).handler(
  () => loadOverviewServerSnapshot(),
)
