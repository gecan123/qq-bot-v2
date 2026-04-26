import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForumReadIdempotencyKey, computeForumItemContentHash } from './forum-read-versioning.js'

describe('forum read artifact versioning', () => {
  test('content hash changes when forum source text changes', () => {
    const base = computeForumItemContentHash({
      title: '帖子标题',
      url: 'https://example.test/post/1',
      author: 'alice',
      rawContent: '旧正文',
    })
    const same = computeForumItemContentHash({
      title: '帖子标题',
      url: 'https://example.test/post/1',
      author: 'alice',
      rawContent: '旧正文',
    })
    const changedBody = computeForumItemContentHash({
      title: '帖子标题',
      url: 'https://example.test/post/1',
      author: 'alice',
      rawContent: '新正文',
    })
    const changedTitle = computeForumItemContentHash({
      title: '新标题',
      url: 'https://example.test/post/1',
      author: 'alice',
      rawContent: '旧正文',
    })

    assert.equal(base, same)
    assert.notEqual(base, changedBody)
    assert.notEqual(base, changedTitle)
  })

  test('forum read idempotency key includes content hash', () => {
    assert.equal(
      buildForumReadIdempotencyKey('feed-item:1', 'hash-a'),
      'forum-item:feed-item:1:content:hash-a',
    )
    assert.notEqual(
      buildForumReadIdempotencyKey('feed-item:1', 'hash-a'),
      buildForumReadIdempotencyKey('feed-item:1', 'hash-b'),
    )
  })
})
