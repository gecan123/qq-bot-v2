import type {
  AgentActivitySurface,
  AgentActivitySurfaceReadResult,
} from '../../../../../src/agent/activity-surface.js'
import { liveAgentActivitySchema, type LiveAgentActivity } from './activity.schema.js'

export type LiveAgentActivityInput = AgentActivitySurfaceReadResult | { status: 'stale' }

export function mapLiveAgentActivity(input: LiveAgentActivityInput): LiveAgentActivity {
  if (input.status !== 'available') {
    return liveAgentActivitySchema.parse({
      available: false,
      sourceStatus: input.status,
      phase: 'unavailable',
      phaseStartedAt: null,
      roundIndex: null,
      detail: null,
      waitUntil: null,
      trigger: null,
      activeTools: [],
      lastCompleted: null,
    })
  }

  const surface: AgentActivitySurface = input.surface
  return liveAgentActivitySchema.parse({
    available: true,
    sourceStatus: 'available',
    phase: surface.phase,
    phaseStartedAt: surface.phaseStartedAt,
    roundIndex: surface.roundIndex,
    detail: surface.detail,
    waitUntil: surface.waitUntil,
    trigger: surface.trigger,
    activeTools: surface.activeTools,
    lastCompleted: surface.lastCompleted,
  })
}
