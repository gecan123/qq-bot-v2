import type {
  ClaudeThinkingMode,
  ClaudeThinkingRetention,
} from '../agent/claude-code/request.js'
import { projectAgentLedger } from '../agent/agent-ledger-projection.js'
import type { CanonicalAgentState } from '../agent/agent-ledger-repo.js'
import { buildWorkingContextProjection } from '../agent/working-context.js'
import type { AgentImageRefStore } from '../media/agent-image-ref.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { AgentContextSurfaceReadResult } from './agent-context-surface.js'
import { analyzeAgentContext, type AgentContextReport } from './agent-context-report.js'

interface LedgerStorageRow {
  id: bigint
  entryType: string
  payload: unknown
  createdAt: Date
}

interface RuntimeStorageRow {
  schemaVersion: number
  mailboxCursors: unknown
  mailboxContinuity: unknown
  goalRevision: number
  activeToolCapabilities: unknown
  qqConversationFocus: unknown
  lastWakeAt: Date | null
  ledgerHeadEntryId: bigint | null
}

interface AgentChatUsageRow {
  ts: Date
  model: string
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
}

export interface AgentContextReportPrismaClient {
  botAgentLedgerEntry: {
    findMany(input: { orderBy: { id: 'asc' } }): Promise<LedgerStorageRow[]>
  }
  botAgentRuntimeState: {
    findUnique(input: { where: { id: 1 } }): Promise<RuntimeStorageRow | null>
  }
  agentTokenUsage: {
    findFirst(input: {
      where: { operation: 'agent.chat' }
      orderBy: [{ ts: 'desc' }, { id: 'desc' }]
      select: {
        ts: true
        model: true
        inputTokens: true
        cachedTokens: true
        outputTokens: true
      }
    }): Promise<AgentChatUsageRow | null>
  }
}

export interface AgentContextReportSource {
  loadCanonicalState(): Promise<CanonicalAgentState>
  loadLatestAgentChatUsage(): Promise<AgentContextReport['latestProviderUsage']>
}

export function createPrismaAgentContextReportSource(
  client: AgentContextReportPrismaClient,
): AgentContextReportSource {
  return {
    async loadCanonicalState() {
      const [rows, runtime] = await Promise.all([
        client.botAgentLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
        client.botAgentRuntimeState.findUnique({ where: { id: 1 } }),
      ])
      if (runtime === null) {
        throw new Error('bot_agent_runtime_state singleton row is missing')
      }
      return {
        entries: rows as CanonicalAgentState['entries'],
        runtimeState: {
          schemaVersion: runtime.schemaVersion,
          mailboxCursors: runtime.mailboxCursors,
          mailboxContinuity: runtime.mailboxContinuity,
          goalRevision: runtime.goalRevision,
          activeToolCapabilities: runtime.activeToolCapabilities,
          qqConversationFocus: runtime.qqConversationFocus,
          lastWakeAt: runtime.lastWakeAt,
          ledgerHeadEntryId: runtime.ledgerHeadEntryId,
        } as CanonicalAgentState['runtimeState'],
      }
    },

    async loadLatestAgentChatUsage() {
      const row = await client.agentTokenUsage.findFirst({
        where: { operation: 'agent.chat' },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        select: {
          ts: true,
          model: true,
          inputTokens: true,
          cachedTokens: true,
          outputTokens: true,
        },
      })
      return row === null ? null : {
        ts: formatBeijingIso(row.ts),
        model: row.model,
        inputTokens: row.inputTokens,
        cachedTokens: row.cachedTokens,
        outputTokens: row.outputTokens,
      }
    },
  }
}

export async function buildCurrentAgentContextReport(input: {
  source: AgentContextReportSource
  surfaceRead: AgentContextSurfaceReadResult
  surfaceStatus: AgentContextReport['surfaceStatus']
  imageRefs: AgentImageRefStore
  reserveTokens: number
  keepRecentTokens: number
  claudeThinkingMode: ClaudeThinkingMode
  claudeThinkingRetention: ClaudeThinkingRetention
  generatedAt: string
  fallbackModel: string
  fallbackProvider: 'claude-code' | 'openai-agent'
  fallbackContextWindowTokens: number
}): Promise<AgentContextReport> {
  const canonical = await input.source.loadCanonicalState()
  const projection = projectAgentLedger(canonical)
  const working = await buildWorkingContextProjection(projection.snapshot.messages, {
    imageRefs: input.imageRefs,
  })
  const latestProviderUsage = await input.source.loadLatestAgentChatUsage()

  return analyzeAgentContext({
    canonicalMessageCount: projection.snapshot.messages.length,
    working,
    surface: input.surfaceRead.status === 'available' ? input.surfaceRead.surface : null,
    surfaceStatus: input.surfaceStatus,
    latestProviderUsage,
    reserveTokens: input.reserveTokens,
    keepRecentTokens: input.keepRecentTokens,
    claudeThinkingMode: input.claudeThinkingMode,
    claudeThinkingRetention: input.claudeThinkingRetention,
    generatedAt: input.generatedAt,
    fallbackModel: input.fallbackModel,
    fallbackProvider: input.fallbackProvider,
    fallbackContextWindowTokens: input.fallbackContextWindowTokens,
  })
}
