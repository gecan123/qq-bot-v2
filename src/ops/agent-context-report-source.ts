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
import {
  loadCanonicalAgentState,
  type CanonicalAgentStatePrismaClient,
} from './agent-ledger-check.js'

interface AgentChatUsageRow {
  ts: Date
  model: string
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
}

export interface AgentContextReportPrismaClient extends CanonicalAgentStatePrismaClient {
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
    async loadCanonicalState() { return loadCanonicalAgentState(client) },

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
  let projection: ReturnType<typeof projectAgentLedger> | null = null
  let projectionError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const canonical = await input.source.loadCanonicalState()
    try {
      projection = projectAgentLedger(canonical)
      break
    } catch (error) {
      projectionError = error
    }
  }
  if (projection === null) throw projectionError
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
