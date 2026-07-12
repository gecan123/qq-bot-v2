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
    assert.match(source, /const lifeJournal = createLifeJournalRuntime\(\{\s*llm: lifeJournalLlm,\s*taskScheduler,\s*\}\)/)
    assert.match(source, /createAgentRuntime\(\{[\s\S]*\blifeJournal,\s*taskScheduler,\s*[\s\S]*\}\)/)
  })

  test('wires ordered graceful shutdown around the running agent', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /createShutdownCoordinator/)
    assert.match(source, /disconnectIngress:\s*\(\) => napcat\.disconnect\(\)/)
    assert.match(source, /stopAgent:\s*\(\) => runtime\.agent\.stop\(\)/)
    assert.match(source, /drainIngress:\s*\(\) => napcatLifecycle\.drain\(\)/)
    assert.match(source, /stopJobs:\s*async \(\) => \{[\s\S]*await taskScheduler\.drain\(\)/)
    assert.match(source, /saveFinal:\s*\(\) => runtime\.agent\.flush\(\)/)
    assert.doesNotMatch(source, /async function shutdown\(\)[\s\S]*process\.exit\(0\)/)
  })

  test('bootstraps an empty AgentContext when no persisted snapshot exists', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /enqueueColdStartBootstrap\(eventQueue, persisted != null\)/)
  })
})
