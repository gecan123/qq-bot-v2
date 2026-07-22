import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

describe('main runtime wiring', () => {
  test('wires only explicit memory maintenance into Agent runtime assembly', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.doesNotMatch(source, /createLifeJournalRuntime/)
    assert.match(source, /import \{ createAgentRuntime \} from '\.\/agent\/runtime\.js'/)
    assert.match(source, /const maintenanceLlm = createLlmClient\(\{\s*claudeThinking: \{ mode: 'disabled' \},\s*\}\)/)
    assert.match(source, /const taskScheduler = createAgentTaskScheduler\(\)/)
    assert.match(source, /const workspaceStateCoordinator = createWorkspaceStateCoordinator\(\)/)
    assert.match(source, /const memoryMaintenance = createMemoryMaintenanceRuntime\(\{\s*llm: maintenanceLlm,\s*taskScheduler,\s*workspaceStateCoordinator,\s*\}\)/)
    assert.match(source, /createAgentRuntime\(\{[\s\S]*\btaskScheduler,\s*memoryMaintenance,\s*workspaceStateCoordinator,\s*[\s\S]*\}\)/)
    assert.match(source, /scheduleStatePath:\s*config\.scheduleStatePath/)
  })

  test('routes startup and shutdown through the startup lifecycle gate', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /import \{ createAgentStartupLifecycle \} from '\.\/ops\/agent-startup-lifecycle\.js'/)
    assert.match(source, /const agentLifecycle = createAgentStartupLifecycle\(\{\s*startBackgroundServices: \(\) => runtime\.startBackgroundServices\(\),\s*startAgent: \(\) => runtime\.agent\.start\(\),\s*stopAgent: \(\) => runtime\.agent\.stop\(\),\s*\}\)/)
    assert.match(source, /stopAgent:\s*agentLifecycle\.stopAgent/)
    assert.match(source, /awaitAgent:\s*agentLifecycle\.awaitAgent/)
    assert.match(source, /await agentLifecycle\.start\(\)/)
    assert.doesNotMatch(source, /agentLoopPromise/)
  })

  test('wires ordered graceful shutdown around the running agent', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /createShutdownCoordinator/)
    assert.match(source, /disconnectIngress:\s*disconnectNapcatForShutdown/)
    assert.match(source, /stopAgent:\s*agentLifecycle\.stopAgent/)
    assert.match(source, /awaitAgent:\s*agentLifecycle\.awaitAgent/)
    assert.match(source, /drainIngress:\s*\(\) => napcatLifecycle\.drain\(\)/)
    assert.match(source, /stopJobs:\s*async \(\) => \{[\s\S]*await taskScheduler\.drain\(\)/)
    assert.match(source, /saveFinal:\s*\(\) => runtime\.agent\.flush\(\)/)
    assert.doesNotMatch(source, /async function shutdown\(\)[\s\S]*process\.exit\(0\)/)
  })

  test('bootstraps an empty AgentContext when the canonical ledger has no entries', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /enqueueColdStartBootstrap\(eventQueue, hasPersistedLedger\)/)
  })

  test('runs best-effort observability cleanup with configured DB and NDJSON retention', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /import \{ purgeObservabilityData \} from '\.\/ops\/observability-retention\.js'/)
    assert.match(
      source,
      /await purgeObservabilityData\(\{\s*retentionDays: config\.observabilityRetentionDays,\s*ndjsonPaths: \[\s*config\.tokenUsageLogPath,\s*config\.toolCallLogPath,\s*config\.fetchLogPath,\s*\],\s*\}\)/,
    )
  })
})
