import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

describe('main runtime wiring', () => {
  test('wires Life Journal runtime into Agent runtime assembly', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /import \{ createLifeJournalRuntime \} from '\.\/agent\/life-journal\.js'/)
    assert.match(source, /import \{ createAgentRuntime \} from '\.\/agent\/runtime\.js'/)
    assert.match(source, /const lifeJournalLlm = createLlmClient\(\{\s*claudeThinking: \{ mode: 'disabled' \},\s*\}\)/)
    assert.match(source, /const taskScheduler = createAgentTaskScheduler\(\)/)
    assert.match(source, /const workspaceStateCoordinator = createWorkspaceStateCoordinator\(\)/)
    assert.match(source, /const lifeJournal = createLifeJournalRuntime\(\{\s*llm: lifeJournalLlm,\s*idlePickTimeoutMs: config\.lifeJournal\.idlePickTimeoutMs,\s*taskScheduler,\s*workspaceStateCoordinator,\s*\}\)/)
    assert.match(source, /const memoryMaintenance = createMemoryMaintenanceRuntime\(\{\s*llm: lifeJournalLlm,\s*taskScheduler,\s*workspaceStateCoordinator,\s*\}\)/)
    assert.match(source, /createAgentRuntime\(\{[\s\S]*\blifeJournal,\s*taskScheduler,\s*memoryMaintenance,\s*workspaceStateCoordinator,\s*[\s\S]*\}\)/)
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
    assert.match(source, /disconnectIngress:\s*\(\) => napcat\.disconnect\(\)/)
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
})
