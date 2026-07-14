import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import {
  renderInterruptedRestAttentionReminder,
  renderRestResumeReminder,
  renderRestResumeReminderCompactionSuffix,
  shouldAppendInterruptedRestAttentionReminder,
  shouldAppendRestResumeReminder,
  stripRestResumeReminderCompactionSuffix,
} from './rest-resume-reminder.js'

const BASE_TIME = new Date('2026-07-13T08:00:00.000Z')

function assistantTool(name: string, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, args: {} }],
  }
}

function toolResult(id: string, content = '{"ok":true}'): AgentMessage {
  return { role: 'tool', toolCallId: id, content }
}

describe('rest resume reminder', () => {
  test('renders a fixed system-reminder without copying a generated direction', () => {
    const rendered = renderRestResumeReminder(BASE_TIME)

    assert.match(rendered, /^<system-reminder>\n/)
    assert.match(rendered, /"event":"rest_resume"/)
    assert.match(rendered, /"emittedAt":"2026-07-13T16:00:00\.000\+08:00"/)
    assert.match(rendered, /本轮最近的 pause 工具结果里的 resumePlan/)
    assert.match(rendered, /两者都已失效.*自然结束当前活动轮/)
    assert.match(rendered, /不要为证明醒来后有行动/)
    assert.match(rendered, /primaryDirection.*alternativeDirection/)
    assert.match(rendered, /\n<\/system-reminder>$/)
    assert.doesNotMatch(rendered, /preferredDirection\s*:/)
  })

  test('renders one fixed attention-transition reminder without copying the suspended direction', () => {
    const rendered = renderInterruptedRestAttentionReminder()

    assert.match(rendered, /"event":"rest_interrupted_attention"/)
    assert.match(rendered, /临时切换.*不会自动取消自己的方向/)
    assert.match(rendered, /最近 pause 工具结果里的 resumePlan/)
    assert.doesNotMatch(rendered, /读一篇具体论文/)
  })

  test('detects interrupted rest followed only by newly disclosed attention', () => {
    const messages: AgentMessage[] = [
      assistantTool('pause', 'pause-1'),
      toolResult('pause-1', JSON.stringify({
        ok: true,
        status: 'interrupted',
        resumePlan: {
          primaryDirection: '读一篇具体论文',
          alternativeDirection: '复核一条研究假设',
        },
      })),
      { role: 'user', content: '{"event":"inbox_update","priority":"high"}' },
    ]

    assert.equal(shouldAppendInterruptedRestAttentionReminder(messages), true)
    assert.equal(shouldAppendInterruptedRestAttentionReminder([
      ...messages,
      { role: 'user', content: renderInterruptedRestAttentionReminder() },
    ]), false)
  })

  test('does not restore interrupted focus after the agent has already acted', () => {
    const messages: AgentMessage[] = [
      assistantTool('pause', 'pause-1'),
      toolResult('pause-1', '{"ok":true,"status":"interrupted","resumePlan":{}}'),
      { role: 'user', content: '{"event":"inbox_update","priority":"high"}' },
      assistantTool('inbox', 'inbox-1'),
      toolResult('inbox-1'),
    ]

    assert.equal(shouldAppendInterruptedRestAttentionReminder(messages), false)
  })

  test('allows the first reminder when the durable ledger has no prior marker', () => {
    assert.equal(shouldAppendRestResumeReminder([], BASE_TIME), true)
  })

  test('suppresses repeated reminders until a non-pause tool succeeds', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: renderRestResumeReminder(BASE_TIME) },
      assistantTool('pause', 'pause-2'),
      toolResult('pause-2'),
    ]

    assert.equal(
      shouldAppendRestResumeReminder(messages, new Date('2026-07-13T09:00:00.000Z')),
      false,
    )
  })

  test('does not treat help or an explicit tool failure as post-rest followthrough', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: renderRestResumeReminder(BASE_TIME) },
      assistantTool('help', 'help-1'),
      toolResult('help-1'),
      assistantTool('notebook', 'notebook-1'),
      toolResult('notebook-1', '{"ok":false,"error":"revision conflict"}'),
    ]

    assert.equal(
      shouldAppendRestResumeReminder(messages, new Date('2026-07-14T08:00:00.000Z')),
      false,
    )
  })

  test('keeps the ten-minute cap after a non-pause tool action', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: renderRestResumeReminder(BASE_TIME) },
      assistantTool('notebook', 'notebook-1'),
      toolResult('notebook-1'),
      assistantTool('pause', 'pause-2'),
      toolResult('pause-2'),
    ]

    assert.equal(
      shouldAppendRestResumeReminder(messages, new Date('2026-07-13T08:09:59.999Z')),
      false,
    )
    assert.equal(
      shouldAppendRestResumeReminder(messages, new Date('2026-07-13T08:10:00.000Z')),
      true,
    )
  })

  test('carries reminder state through compaction without re-emitting the instruction', () => {
    const beforeCompaction: AgentMessage[] = [
      { role: 'user', content: renderRestResumeReminder(BASE_TIME) },
      assistantTool('notebook', 'notebook-1'),
      toolResult('notebook-1'),
    ]
    const suffix = renderRestResumeReminderCompactionSuffix(beforeCompaction)
    const compactedSummary = `[历史摘要]\n保留关键历史。${suffix}`
    const compactedMessages: AgentMessage[] = [
      { role: 'user', content: compactedSummary },
      assistantTool('pause', 'pause-2'),
      toolResult('pause-2'),
    ]

    assert.match(suffix, /"event":"rest_resume_state"/)
    assert.doesNotMatch(suffix, /你刚短暂休息过/)
    assert.equal(
      shouldAppendRestResumeReminder(compactedMessages, new Date('2026-07-13T08:09:59.999Z')),
      false,
    )
    assert.equal(
      shouldAppendRestResumeReminder(compactedMessages, new Date('2026-07-13T08:10:00.000Z')),
      true,
    )
    assert.equal(stripRestResumeReminderCompactionSuffix(compactedSummary), '[历史摘要]\n保留关键历史。')
  })

  test('keeps suppressing reminders after compaction when no action occurred', () => {
    const beforeCompaction: AgentMessage[] = [
      { role: 'user', content: renderRestResumeReminder(BASE_TIME) },
      assistantTool('pause', 'pause-2'),
      toolResult('pause-2'),
    ]
    const compactedMessages: AgentMessage[] = [{
      role: 'user',
      content: `[历史摘要]\n保留关键历史。${renderRestResumeReminderCompactionSuffix(beforeCompaction)}`,
    }]

    assert.equal(
      shouldAppendRestResumeReminder(compactedMessages, new Date('2026-07-14T08:00:00.000Z')),
      false,
    )
  })
})
