import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type { LlmClient, LlmCallInput } from './llm-client.js'
import { createLifeJournalRuntime } from './life-journal.js'

describe('life journal runtime', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'life-journal-runtime-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('recordRound writes journal and agenda from strict JSON review', async () => {
    let captured: LlmCallInput | null = null
    const llm: LlmClient = {
      async chat(input) {
        captured = input
        assert.equal(input.tools.length, 0)
        assert.match(input.systemPrompt, /Life Journal/)
        return {
          content: JSON.stringify({
            shouldWrite: true,
            journalMarkdown: '### Saw\n- 用户确认让我自己写。\n\n### Did\n- 形成计划。\n',
            agendaMarkdown: '# Agenda\n\n## Active\n- [ ] 继续设计\n',
          }),
          toolCalls: [],
          usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({
      rootDir,
      llm,
      now: () => new Date('2026-07-07T15:18:00.000Z'),
    })

    const result = await runtime.recordRound({
      roundIndex: 7,
      messages: [{ role: 'user', content: '这一轮确认让我自己写 journal' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: true, updatedAgenda: true })
    assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /用户确认/)
    assert.equal(await readFile(join(rootDir, 'life', 'agenda.md'), 'utf8'), '# Agenda\n\n## Active\n- [ ] 继续设计\n')
    assert.ok(captured)
    assert.deepEqual(captured.messages, [
      { role: 'user', content: '这一轮确认让我自己写 journal' },
    ])
  })

  test('recordRound updates agenda only when agenda markdown is non-empty', async () => {
    const llm: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            shouldWrite: true,
            journalMarkdown: '### Saw\n- 有新事实。\n',
            agendaMarkdown: '',
          }),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm })

    const result = await runtime.recordRound({
      roundIndex: 1,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, true)
    assert.equal(result.wroteJournal, true)
    assert.equal(result.updatedAgenda, false)
    assert.match(await readFile(join(rootDir, 'life', 'agenda.md'), 'utf8'), /## Active/)
  })

  test('recordRound returns ok false for invalid JSON and does not throw', async () => {
    const llm: LlmClient = {
      async chat() {
        return {
          content: 'not json',
          toolCalls: [],
          usage: { inputTokens: null, cachedTokens: null, outputTokens: null },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm })

    const result = await runtime.recordRound({
      roundIndex: 1,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, false)
    await assert.rejects(readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'))
  })

  test('recordRound sends only bounded current-round messages', async () => {
    let captured: LlmCallInput | null = null
    const llm: LlmClient = {
      async chat(input) {
        captured = input
        return {
          content: JSON.stringify({ shouldWrite: false, journalMarkdown: '', agendaMarkdown: '' }),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm, maxRoundChars: 22 })

    await runtime.recordRound({
      roundIndex: 1,
      messages: [
        { role: 'user', content: 'current round message that is far too long' },
        { role: 'assistant', content: 'assistant response', toolCalls: [] },
      ],
    })

    assert.ok(captured)
    const serialized = JSON.stringify(captured.messages)
    assert.equal(serialized.includes('current round message'), true)
    assert.equal(serialized.includes('far too long'), false)
    assert.equal(serialized.includes('old AgentContext history'), false)
  })
})
