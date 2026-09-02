import '@tanstack/react-start/server-only'
import { readLiveAgentActivity } from '../../server/agent-activity.server.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot } from '../../server/paths.server.js'
import { loadOverviewToolActivity } from './overview-tool-log.server.js'
import { loadOverviewSnapshot } from './overview.service.js'

export async function loadOverviewServerSnapshot(now = new Date()) {
  const root = getRepositoryRoot()
  const [activity, toolActivity] = await Promise.all([
    readLiveAgentActivity(root),
    loadOverviewToolActivity(root, now),
  ])
  return await loadOverviewSnapshot(
    getAdminPrisma(),
    now,
    activity,
    toolActivity,
  )
}
