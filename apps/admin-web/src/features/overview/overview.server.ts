import '@tanstack/react-start/server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_ACTIVITY_SURFACE_PATH,
  readAgentActivitySurface,
} from '../../../../../src/agent/activity-surface.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot } from '../../server/paths.server.js'
import { loadOverviewToolActivity } from './overview-tool-log.server.js'
import { loadOverviewSnapshot, type OverviewActivityInput } from './overview.service.js'

export async function loadOverviewServerSnapshot(now = new Date()) {
  const root = getRepositoryRoot()
  const [activity, toolActivity] = await Promise.all([
    readAgentActivitySurface(join(root, AGENT_ACTIVITY_SURFACE_PATH))
      .then(value => validateLiveProcess(root, value)),
    loadOverviewToolActivity(root, now),
  ])
  return await loadOverviewSnapshot(
    getAdminPrisma(),
    now,
    activity,
    toolActivity,
  )
}

async function validateLiveProcess(
  root: string,
  activity: Awaited<ReturnType<typeof readAgentActivitySurface>>,
): Promise<OverviewActivityInput> {
  if (activity.status !== 'available') return activity
  let pid: number | null = null
  try {
    const raw = (await readFile(join(root, '.bot.pid'), 'utf8')).trim()
    pid = /^\d+$/.test(raw) ? Number(raw) : null
  } catch {
    return { status: 'stale' }
  }
  if (pid !== activity.surface.pid || !Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'stale' }
  }
  try {
    process.kill(pid, 0)
    return activity
  } catch {
    return { status: 'stale' }
  }
}
