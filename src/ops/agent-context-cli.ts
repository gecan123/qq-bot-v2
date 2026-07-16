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

export interface AgentContextCliIo {
  writeStdout(value: string): void
  writeStderr(value: string): void
}

export interface AgentContextCliDependencies {
  loadRuntime(): Promise<AgentContextCliRuntime>
  buildOutput(runtime: AgentContextCliRuntime, options: { json: boolean }): Promise<string>
}

const defaultDependencies: AgentContextCliDependencies = {
  loadRuntime: loadDefaultRuntime,
  buildOutput: buildDefaultOutput,
}

export async function runAgentContextCli(
  args: string[],
  io: AgentContextCliIo,
  dependencies: AgentContextCliDependencies = defaultDependencies,
): Promise<0 | 1> {
  let runtime: AgentContextCliRuntime | undefined
  let output: string | undefined
  let failed = false
  let failure: unknown

  try {
    const options = parseAgentContextArgs(args)
    runtime = await dependencies.loadRuntime()
    await runtime.prisma.$connect()
    output = await dependencies.buildOutput(runtime, options)
  } catch (error) {
    failed = true
    failure = error
  }

  if (runtime !== undefined) {
    try {
      await runtime.prisma.$disconnect()
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }

  if (failed) {
    io.writeStderr(`${JSON.stringify({
      ok: false,
      code: 'agent_context_report_failed',
      error: errorMessage(failure),
    })}\n`)
    return 1
  }

  io.writeStdout(`${output ?? ''}\n`)
  return 0
}

async function loadDefaultRuntime(): Promise<AgentContextCliRuntime> {
  // Keep configuration and Prisma initialization inside runAgentContextCli's error boundary.
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
    classifySurfaceStatus,
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
  const surfaceStatus = await classifySurfaceStatus(surfaceRead, '.bot.pid')
  const report = await buildCurrentAgentContextReport({
    source: createPrismaAgentContextReportSource(runtime.prisma),
    surfaceRead,
    surfaceStatus,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
