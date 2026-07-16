import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import {
  CLAUDE_CODE_PROVIDER_NAME,
  config,
  OPENAI_AGENT_PROVIDER_NAME,
} from '../src/config/index.js'
import { prisma } from '../src/database/client.js'
import { agentImageRefStore } from '../src/media/agent-image-ref.js'
import {
  AGENT_CONTEXT_SURFACE_PATH,
  classifySurfaceStatus,
  readAgentContextSurface,
} from '../src/ops/agent-context-surface.js'
import {
  buildCurrentAgentContextReport,
  createPrismaAgentContextReportSource,
  type AgentContextReportPrismaClient,
} from '../src/ops/agent-context-report-source.js'
import {
  parseAgentContextArgs,
  renderAgentContextReport,
  renderAgentContextReportJson,
} from '../src/ops/agent-context-report-render.js'
import { formatBeijingIso } from '../src/utils/beijing-time.js'

try {
  const options = parseAgentContextArgs(process.argv.slice(2))
  const fallbackProvider = config.llm.defaultProvider
  if (
    fallbackProvider !== CLAUDE_CODE_PROVIDER_NAME
    && fallbackProvider !== OPENAI_AGENT_PROVIDER_NAME
  ) {
    throw new Error(`unsupported default provider: ${fallbackProvider}`)
  }
  await prisma.$connect()

  const surfaceRead = await readAgentContextSurface(AGENT_CONTEXT_SURFACE_PATH)
  const surfaceStatus = await classifySurfaceStatus(
    surfaceRead,
    '.bot.pid',
    async (path, encoding) => readFile(path, encoding),
    (pid, signal) => process.kill(pid, signal),
  )
  const report = await buildCurrentAgentContextReport({
    source: createPrismaAgentContextReportSource(
      prisma as unknown as AgentContextReportPrismaClient,
    ),
    surfaceRead,
    surfaceStatus,
    imageRefs: agentImageRefStore,
    reserveTokens: config.compaction.reserveTokens,
    keepRecentTokens: config.compaction.keepRecentTokens,
    claudeThinkingMode: config.llm.claudeThinking.mode,
    claudeThinkingRetention: config.llm.claudeThinking.retention,
    generatedAt: formatBeijingIso(new Date()),
    fallbackModel: config.llm.defaultModel,
    fallbackProvider,
    fallbackContextWindowTokens:
      config.llm.contextWindowTokensByModel[config.llm.defaultModel]!,
  })

  process.stdout.write(`${options.json
    ? renderAgentContextReportJson(report)
    : renderAgentContextReport(report)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'agent_context_report_failed',
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
