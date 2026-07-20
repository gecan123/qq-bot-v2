import { createServerFn } from '@tanstack/react-start'
import { getAdminPrisma } from '../../server/db.server.js'
import { loadOverviewSnapshot } from './overview.service.js'

export const getOverviewSnapshot = createServerFn({ method: 'GET' }).handler(
  () => loadOverviewSnapshot(getAdminPrisma()),
)
