import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createMemoryTool } from './memory.js'

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

describe('memory tool', () => {
  test('closes the remember -> recall -> correct loop with recall revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-tool-'))
    try {
      const tool = createMemoryTool({
        workspaceDir: root,
        now: () => new Date('2026-07-13T00:00:00.000Z'),
        id: (() => {
          let id = 0
          return () => `entry-${++id}`
        })(),
      })
      const remembered = await tool.execute({
        action: 'remember',
        scope: 'self',
        content: '我偏好先验证事实，再给结论。',
      }, ctx)
      assert.equal(JSON.parse(remembered.content as string).entryId, 'entry-1')

      const recalled = await tool.execute({
        action: 'recall',
        query: '验证事实',
        scope: 'self',
      }, ctx)
      const match = JSON.parse(recalled.content as string).matches[0]
      assert.equal(match.entryId, 'entry-1')
      assert.match(match.revision, /^[a-f0-9]{64}$/)

      const corrected = await tool.execute({
        action: 'correct',
        file: match.file,
        entryId: match.entryId,
        expectedRevision: match.revision,
        content: '我偏好先核对代码和日志，再给结论。',
      }, ctx)
      assert.equal(JSON.parse(corrected.content as string).replacementEntryId, 'entry-2')

      const after = await tool.execute({
        action: 'recall',
        query: '代码 日志',
        scope: 'self',
      }, ctx)
      const matches = JSON.parse(after.content as string).matches
      assert.equal(matches.length, 1)
      assert.equal(matches[0].entryId, 'entry-2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('schema exposes exactly remember, recall and correct', () => {
    const schema = createMemoryTool().schema
    for (const action of ['write', 'search', 'review', 'read', 'list', 'delete', 'compact', 'promote_entry']) {
      assert.equal(schema.safeParse({ action }).success, false, action)
    }
    assert.equal(schema.safeParse({
      action: 'remember',
      scope: 'self',
      content: '这是一条中文长期记忆。',
    }).success, true)
    assert.equal(schema.safeParse({ action: 'recall', query: '旧事' }).success, true)
  })

  test('person and group memories still require message evidence', () => {
    const schema = createMemoryTool().schema
    assert.equal(schema.safeParse({
      action: 'remember',
      scope: 'person',
      id: 123,
      content: '这个人偏好简短回复。',
      memoryKind: 'person_preference',
    }).success, false)
    assert.equal(schema.safeParse({
      action: 'correct',
      file: 'groups/123.md',
      entryId: 'entry-1',
      expectedRevision: 'a'.repeat(64),
      content: '这个群更适合只在被提及时回复。',
    }).success, false)
  })
})
