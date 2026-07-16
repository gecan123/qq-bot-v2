import type { AgentImageRefStore } from '../media/agent-image-ref.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { AgentContextReportPrismaClient } from './agent-context-report-source.js'
import {
  parseAgentContextArgs,
  renderAgentContextReport,
  renderAgentContextReportJson,
} from './agent-context-report-render.js'

interface AgentContextCliPrisma extends AgentContextReportPrismaClient {
  $connect(): Promise<void>
  $disconnect(): Promise<void>
}

interface AgentContextCliConfig {
  compaction: {
    reserveTokens: number
    keepRecentTokens: number
  }
  llm: {
    defaultProvider: string
    defaultModel: string
    contextWindowTokensByModel: Record<string, number>
    claudeThinking: {
      mode: 'disabled' | 'adaptive'
      retention: 'active-tool-cycle' | 'always'
    }
  }
}

export interface AgentContextCliRuntime {
  config: AgentContextCliConfig
  prisma: AgentContextCliPrisma
  imageRefs: AgentImageRefStore
}

export async function buildAgentContextCliOutput(
  args: string[],
  loadRuntime: () => Promise<AgentContextCliRuntime> = loadDefaultRuntime,
): Promise<string> {
  const options = parseAgentContextArgs(args)
  const runtime = await loadRuntime()
  await runtime.prisma.$connect()
  try {
    return await buildDefaultOutput(runtime, options)
  } finally {
    await runtime.prisma.$disconnect()
  }
}

async function loadDefaultRuntime(): Promise<AgentContextCliRuntime> {
  // Keep configuration and Prisma initialization inside the script's error boundary.
  const { config } = await import('../config/index.js')
  const { prisma } = await import('../database/client.js')
  const { agentImageRefStore } = await import('../media/agent-image-ref.js')
  return {
    config,
    prisma: prisma as unknown as AgentContextCliPrisma,
    imageRefs: agentImageRefStore,
  }
}

async function buildDefaultOutput(
  runtime: AgentContextCliRuntime,
  options: { json: boolean },
): Promise<string> {
  const {
    AGENT_CONTEXT_SURFACE_PATH,
    readAgentContextSurface,
  } = await import('./agent-context-surface.js')
  const {
    buildCurrentAgentContextReport,
    createPrismaAgentContextReportSource,
  } = await import('./agent-context-report-source.js')
  const fallbackProvider = runtime.config.llm.defaultProvider
  if (fallbackProvider !== 'claude-code' && fallbackProvider !== 'openai-agent') {
    throw new Error(`unsupported default provider: ${fallbackProvider}`)
  }
  const fallbackContextWindowTokens =
    runtime.config.llm.contextWindowTokensByModel[runtime.config.llm.defaultModel]
  if (!Number.isSafeInteger(fallbackContextWindowTokens) || fallbackContextWindowTokens <= 0) {
    throw new Error(`missing context window for default model: ${runtime.config.llm.defaultModel}`)
  }

  const surfaceRead = await readAgentContextSurface(AGENT_CONTEXT_SURFACE_PATH)
  const report = await buildCurrentAgentContextReport({
    source: createPrismaAgentContextReportSource(runtime.prisma),
    surfaceRead,
    surfaceStatus: surfaceRead.status,
    imageRefs: runtime.imageRefs,
    reserveTokens: runtime.config.compaction.reserveTokens,
    keepRecentTokens: runtime.config.compaction.keepRecentTokens,
    claudeThinkingMode: runtime.config.llm.claudeThinking.mode,
    claudeThinkingRetention: runtime.config.llm.claudeThinking.retention,
    generatedAt: formatBeijingIso(new Date()),
    fallbackModel: runtime.config.llm.defaultModel,
    fallbackProvider,
    fallbackContextWindowTokens,
  })
  return options.json
    ? renderAgentContextReportJson(report)
    : renderAgentContextReport(report)
}
