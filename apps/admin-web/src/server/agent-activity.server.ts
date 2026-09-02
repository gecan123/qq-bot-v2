import '@tanstack/react-start/server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_ACTIVITY_SURFACE_PATH,
  readAgentActivitySurface,
} from '../../../../src/agent/activity-surface.js'
import type { LiveAgentActivityInput } from '../features/activity/activity.service.js'
import { getRepositoryRoot } from './paths.server.js'

export async function readLiveAgentActivity(root = getRepositoryRoot()): Promise<LiveAgentActivityInput> {
  const activity = await readAgentActivitySurface(join(root, AGENT_ACTIVITY_SURFACE_PATH))
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
