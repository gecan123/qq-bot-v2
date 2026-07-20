import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  renderShareCheckpoint,
  selectShareCheckpointCandidate,
} from './share-checkpoint.js'

describe('share checkpoint', () => {
  test('selects the latest successful new candidate and renders bounded active targets', () => {
    const candidate = selectShareCheckpointCandidate([
      {
        toolCallId: 'one',
        requestedToolName: 'notebook',
        toolName: 'notebook',
        ok: true,
        progress: true,
        shareCandidate: { key: 'note:one', cooldownKey: 'topic:one', summary: '第一项成果' },
      },
      {
        toolCallId: 'two',
        requestedToolName: 'memory',
        toolName: 'memory',
        ok: true,
        progress: true,
        shareCandidate: { key: 'memory:two', cooldownKey: 'topic:two', summary: '第二项成果' },
      },
    ], [])

    assert.deepEqual(candidate, {
      key: 'memory:two',
      cooldownKey: 'topic:two',
      summary: '第二项成果',
      sourceTool: 'memory',
    })
    const payload = JSON.parse(renderShareCheckpoint(candidate!, [{
      groupId: 253631878,
      groupName: '程序喵 AI 竞技场',
      residentHint: '研究成果的首选分享场所。',
    }], new Date('2026-07-20T12:00:00.000Z')))
    assert.equal(payload.event, 'share_checkpoint')
    assert.equal(payload.activeGroups[0].groupId, 253631878)
    assert.match(payload.instruction, /不是发言任务/)
    assert.match(payload.instruction, /私人内容.*敏感信息.*重复内容/)
  })

  test('does not select failed, unchanged, or already checkpointed candidates', () => {
    const existing = renderShareCheckpoint({
      key: 'note:same',
      cooldownKey: 'topic:same',
      summary: '已经判断过',
      sourceTool: 'notebook',
    }, [], new Date('2026-07-20T12:00:00.000Z'))
    assert.equal(selectShareCheckpointCandidate([
      {
        toolCallId: 'failed',
        requestedToolName: 'notebook',
        toolName: 'notebook',
        ok: false,
        progress: true,
        shareCandidate: { key: 'note:failed', cooldownKey: 'topic:failed', summary: '失败结果' },
      },
      {
        toolCallId: 'unchanged',
        requestedToolName: 'notebook',
        toolName: 'notebook',
        ok: true,
        progress: false,
        shareCandidate: { key: 'note:unchanged', cooldownKey: 'topic:unchanged', summary: '旧结果' },
      },
      {
        toolCallId: 'same',
        requestedToolName: 'notebook',
        toolName: 'notebook',
        ok: true,
        progress: true,
        shareCandidate: { key: 'note:same', cooldownKey: 'topic:same', summary: '已经判断过' },
      },
    ], [{ role: 'user', content: existing }], new Date('2026-07-20T12:30:00.000Z')), null)
  })

  test('suppresses a different artifact from the same topic during the cooldown', () => {
    const existing = renderShareCheckpoint({
      key: 'note:v1',
      cooldownKey: 'topic:sol',
      summary: '第一版结论',
      sourceTool: 'notebook',
    }, [], new Date('2026-07-20T12:00:00.000Z'))
    const outcomes = [{
      toolCallId: 'new',
      requestedToolName: 'notebook',
      toolName: 'notebook',
      ok: true,
      progress: true,
      shareCandidate: { key: 'note:v2', cooldownKey: 'topic:sol', summary: '第二版结论' },
    }]

    assert.equal(selectShareCheckpointCandidate(
      outcomes,
      [{ role: 'user', content: existing }],
      new Date('2026-07-20T13:00:00.000Z'),
    ), null)
    assert.equal(selectShareCheckpointCandidate(
      outcomes,
      [{ role: 'user', content: existing }],
      new Date('2026-07-20T14:00:01.000Z'),
    )?.key, 'note:v2')
  })
})
