import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type { LlmClient, LlmCallInput } from './llm-client.js'
import { createLifeJournalRuntime } from './life-journal.js'
import { appendLifeJournalEntry, writeLifeAgenda } from './life-journal-store.js'
import type { TokenUsageEntry } from './token-stats.js'

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
        assert.equal(input.tools.length, 1)
        assert.equal(input.tools[0]!.name, 'life_journal_review_result')
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
    const capturedInput = captured as LlmCallInput
    assert.equal(capturedInput.messages.length, 2)
    assert.match(capturedInput.messages[0]!.content as string, /# Current Life Journal state/)
    assert.match(capturedInput.messages[0]!.content as string, /## Current Agenda/)
    assert.deepEqual(capturedInput.messages[1], { role: 'user', content: '这一轮确认让我自己写 journal' })
  })

  test('recordRound reviews the current agenda and recent journal before deciding', async () => {
    const now = () => new Date('2026-07-07T15:18:00.000Z')
    await writeLifeAgenda({ rootDir, now }, `# Agenda

## Active
- [ ] 修复 journal reviewer

## Waiting

## Someday

## Done
`)
    await appendLifeJournalEntry({
      rootDir,
      now,
      markdown: '### Promised\n- 我答应继续修 reviewer。',
    })

    let captured: LlmCallInput | null = null
    const llm: LlmClient = {
      async chat(input) {
        captured = input
        return {
          content: 'SKIP',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm, now })

    await runtime.recordRound({
      roundIndex: 2,
      messages: [{ role: 'user', content: '继续处理' }],
    })

    assert.ok(captured)
    const state = (captured as LlmCallInput).messages[0]!.content as string
    assert.match(state, /修复 journal reviewer/)
    assert.match(state, /我答应继续修 reviewer/)
    assert.match((captured as LlmCallInput).systemPrompt, /Preserve unrelated items/)
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

  test('recordRound safely skips prose after one retry', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls += 1
        return {
          content: '不写日记了，这轮没什么需要记录的。',
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

    assert.deepEqual(result, { ok: true, wroteJournal: false, updatedAgenda: false })
    assert.equal(calls, 2)
    await assert.rejects(readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'))
  })

  test('recordRound accepts SKIP without retrying', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls += 1
        return {
          content: 'SKIP',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm })

    const result = await runtime.recordRound({
      roundIndex: 1,
      messages: [{ role: 'user', content: '常规群聊' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: false, updatedAgenda: false })
    assert.equal(calls, 1)
  })

  test('recordRound writes journal and agenda from RECORD fallback protocol', async () => {
    const llm: LlmClient = {
      async chat() {
        return {
          content: `RECORD
<<<JOURNAL>>>
### Saw
- LongCat 使用了文本回退协议。
<<<AGENDA>>>
# Agenda

## Active
- [ ] 继续观察回退成功率
`,
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
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
      roundIndex: 4,
      messages: [{ role: 'user', content: '记录这个兼容性修复' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: true, updatedAgenda: true })
    assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /文本回退协议/)
    assert.match(await readFile(join(rootDir, 'life', 'agenda.md'), 'utf8'), /继续观察回退成功率/)
  })

  test('recordRound retries once when review response is not JSON', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat(input) {
        calls += 1
        if (calls === 1) {
          return {
            content: 'not json',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
          }
        }
        assert.match(input.systemPrompt, /follow the SKIP\/RECORD fallback protocol exactly/)
        return {
          content: JSON.stringify({
            shouldWrite: true,
            journalMarkdown: '### Saw\n- 第二次返回了 JSON。\n',
            agendaMarkdown: '',
          }),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
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
      roundIndex: 1,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: true, updatedAgenda: false })
    assert.equal(calls, 2)
    assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /第二次返回了 JSON/)
  })

  test('recordRound reads structured review from tool call args instead of prose content', async () => {
    let captured: LlmCallInput | null = null
    const llm: LlmClient = {
      async chat(input) {
        captured = input
        return {
          content: 'Luna is being asked by zzz whether she can currently view webpages using Chrome.',
          toolCalls: [{
            id: 'review-result',
            name: 'life_journal_review_result',
            args: {
              shouldWrite: true,
              journalMarkdown: '### Saw\n- zzz 问我现在能不能用 Chrome 看网页。\n',
              agendaMarkdown: '',
            },
          }],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
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
      roundIndex: 2,
      messages: [{ role: 'user', content: '你现在能看到 Chrome 网页吗？' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: true, updatedAgenda: false })
    assert.ok(captured)
    const capturedInput = captured as LlmCallInput
    assert.equal(capturedInput.tools.length, 1)
    assert.equal(capturedInput.tools[0]!.name, 'life_journal_review_result')
    assert.match(await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'), /Chrome/)
  })

  test('recordRound treats empty structured review responses as a skipped write', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls += 1
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({ rootDir, llm })

    const result = await runtime.recordRound({
      roundIndex: 3,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.deepEqual(result, { ok: true, wroteJournal: false, updatedAgenda: false })
    assert.equal(calls, 2)
    await assert.rejects(readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8'))
  })

  test('recordRound throttles automatic journal writes', async () => {
    let now = new Date('2026-07-07T15:00:00.000Z')
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls += 1
        return {
          content: JSON.stringify({
            shouldWrite: true,
            journalMarkdown: '### Saw\n- 这轮模型觉得要写。\n',
            agendaMarkdown: '',
          }),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createLifeJournalRuntime({
      rootDir,
      llm,
      now: () => now,
      minWriteIntervalMs: 10 * 60 * 1000,
    })

    const first = await runtime.recordRound({
      roundIndex: 1,
      messages: [{ role: 'user', content: 'first' }],
    })
    now = new Date('2026-07-07T15:05:00.000Z')
    const second = await runtime.recordRound({
      roundIndex: 2,
      messages: [{ role: 'user', content: 'second' }],
    })
    now = new Date('2026-07-07T15:11:00.000Z')
    const third = await runtime.recordRound({
      roundIndex: 3,
      messages: [{ role: 'user', content: 'third' }],
    })

    assert.deepEqual(first, { ok: true, wroteJournal: true, updatedAgenda: false })
    assert.deepEqual(second, { ok: true, wroteJournal: false, updatedAgenda: false })
    assert.deepEqual(third, { ok: true, wroteJournal: true, updatedAgenda: false })
    assert.equal(calls, 2)
    const journal = await readFile(join(rootDir, 'life', 'journal', '2026-07-07.md'), 'utf8')
    assert.match(journal, /Round 1/)
    assert.doesNotMatch(journal, /Round 2/)
    assert.match(journal, /Round 3/)
  })

  test('recordRound returns when the review LLM exceeds its timeout', async () => {
    const llm: LlmClient = {
      async chat() {
        return await new Promise(() => {})
      },
    }
    const runtime = createLifeJournalRuntime({
      rootDir,
      llm,
      reviewTimeoutMs: 10,
    })

    const result = await runtime.recordRound({
      roundIndex: 1,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /timed out/i)
  })

  test('recordRound records completed review token usage', async () => {
    const usageEntries: TokenUsageEntry[] = []
    const llm: LlmClient = {
      async chat() {
        return {
          content: 'SKIP',
          toolCalls: [],
          usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 5 },
          model: 'journal-model',
        }
      },
    }
    const runtime = createLifeJournalRuntime({
      rootDir,
      llm,
      recordUsage: (entry) => usageEntries.push(entry),
    })

    await runtime.recordRound({
      roundIndex: 12,
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert.deepEqual(usageEntries, [{
      operation: 'life_journal.review',
      roundIndex: 12,
      inputTokens: 100,
      cachedTokens: 20,
      outputTokens: 5,
      model: 'journal-model',
    }])
  })

  test('recordRound sends bounded state and current-round messages without old AgentContext history', async () => {
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
    await writeLifeAgenda({ rootDir }, `# Agenda\n\n## Active\n- [ ] ${'state '.repeat(100)}`)
    const runtime = createLifeJournalRuntime({ rootDir, llm, maxRoundChars: 22, maxStateChars: 100 })

    await runtime.recordRound({
      roundIndex: 1,
      messages: [
        { role: 'user', content: 'current round message that is far too long' },
        { role: 'assistant', content: 'assistant response', toolCalls: [] },
      ],
    })

    assert.ok(captured)
    const capturedInput = captured as LlmCallInput
    const serialized = JSON.stringify(capturedInput.messages)
    assert.equal(serialized.includes('current round message'), true)
    assert.equal(serialized.includes('far too long'), false)
    assert.equal(serialized.includes('old AgentContext history'), false)
    assert.match((capturedInput.messages[0]!.content as string), /\[truncated\]/)
    assert.ok((capturedInput.messages[0]!.content as string).length < 120)
  })

  test('recordRound replaces non-text tool result blocks with bounded placeholders', async () => {
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
    const runtime = createLifeJournalRuntime({ rootDir, llm })

    await runtime.recordRound({
      roundIndex: 1,
      messages: [{
        role: 'tool',
        toolCallId: 'image-call',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'BASE64_IMAGE_DATA_MUST_NOT_REACH_REVIEW_LLM',
            },
          },
        ],
      }],
    })

    assert.ok(captured)
    const capturedInput = captured as LlmCallInput
    const serialized = JSON.stringify(capturedInput.messages)
    assert.equal(serialized.includes('BASE64_IMAGE_DATA_MUST_NOT_REACH_REVIEW_LLM'), false)
    assert.match(serialized, /non-text tool result omitted/)
  })
})
