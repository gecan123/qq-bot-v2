import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import type { TimelineSnapshot } from './timeline.schema.js'
import { buildTimelineSnapshot } from './timeline.service.js'

export async function loadTimelineSnapshot(now = new Date()): Promise<TimelineSnapshot> {
  const db = getAdminPrisma()
  const [ledger, tools, tokens, llmCalls] = await Promise.all([
    db.botAgentLedgerEntry.findMany({ orderBy: { id: 'desc' }, take: 80 }),
    db.agentToolCall.findMany({ orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 100 }),
    db.agentTokenUsage.findMany({ orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 80 }),
    db.agentLlmCall.findMany({ orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 80 }),
  ])
  return buildTimelineSnapshot({ now, ledger, tools, tokens, llmCalls })
}
