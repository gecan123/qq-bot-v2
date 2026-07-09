import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

describe('main runtime wiring', () => {
  test('wires Life Journal runtime into Agent runtime assembly', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    assert.match(source, /import \{ createLifeJournalRuntime \} from '\.\/agent\/life-journal\.js'/)
    assert.match(source, /import \{ createAgentRuntime \} from '\.\/agent\/runtime\.js'/)
    assert.match(source, /const lifeJournal = createLifeJournalRuntime\(\{\s*llm,\s*\}\)/)
    assert.match(source, /createAgentRuntime\(\{[\s\S]*\blifeJournal,\s*[\s\S]*\}\)/)
  })
})
