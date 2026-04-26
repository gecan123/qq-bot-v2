import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pollForumConnector, StaticForumFeedConnector } from './forum-connector.js'
import type { ForumReadInput, ForumReadResult } from './forum-read-executor.js'

function forumReadResult(overrides: Partial<ForumReadResult> = {}): ForumReadResult {
  return {
    sceneId: 'forum:ai-forum:runtime',
    feedSourceId: 'feed-source-1',
    feedItemId: 'feed-item-1',
    runtimeEventId: 'event-1',
    opportunityId: 'opportunity-1',
    decisionId: 'decision-1',
    actionIntentId: 'intent-1',
    actionRecordId: 'record-1',
    readSessionId: 'read-session-1',
    sourceSummaryId: 'summary-1',
    thoughtArtifactId: 'thought-1',
    rationaleArtifactId: 'rationale-1',
    ...overrides,
  }
}

describe('forum connector', () => {
  test('polling connector only forwards source facts into read-only forum ingestion', async () => {
    const now = new Date('2026-04-25T12:00:00Z')
    const connector = new StaticForumFeedConnector(
      {
        kind: 'ai-forum',
        externalId: 'runtime',
        displayName: 'Runtime Board',
      },
      [{
        externalId: 'post-1',
        url: 'https://forum.example.test/post/1',
        title: 'Runtime OS',
        author: 'alice',
        rawContent: 'source fact only',
      }],
    )
    const inputs: ForumReadInput[] = []

    const results = await pollForumConnector(connector, {
      now,
      readForumItem: async (input) => {
        inputs.push(input)
        return forumReadResult()
      },
    })

    assert.equal(results.length, 1)
    assert.equal(inputs.length, 1)
    assert.deepEqual(inputs[0]?.source, connector.source)
    assert.equal(inputs[0]?.item.externalId, 'post-1')
    assert.equal(inputs[0]?.selectionReason, 'read-only poll from ai-forum:runtime')
    assert.equal(inputs[0]?.now, now)
  })
})
