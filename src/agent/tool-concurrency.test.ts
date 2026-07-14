import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isParallelSafeToolCall } from './tool-concurrency.js'

function call(name: string, args: Record<string, unknown> = {}) {
  return { id: 'call-1', name, args }
}

describe('tool concurrency policy', () => {
  test('allows only explicit read-only actions', () => {
    assert.equal(isParallelSafeToolCall(call('inbox', { action: 'read' })), true)
    assert.equal(isParallelSafeToolCall(call('memory', { action: 'recall' })), true)
    assert.equal(isParallelSafeToolCall(call('memory', { action: 'delete' })), false)
    assert.equal(isParallelSafeToolCall(call('notebook', { action: 'list' })), true)
    assert.equal(isParallelSafeToolCall(call('notebook', { action: 'search' })), true)
    assert.equal(isParallelSafeToolCall(call('notebook', { action: 'read' })), true)
    assert.equal(isParallelSafeToolCall(call('notebook', { action: 'write' })), false)
    assert.equal(isParallelSafeToolCall(call('schedule', { action: 'list' })), true)
    assert.equal(isParallelSafeToolCall(call('schedule', { action: 'create' })), false)
    assert.equal(isParallelSafeToolCall(call('schedule', { action: 'cancel' })), false)
    assert.equal(isParallelSafeToolCall(call('schedule')), false)
    assert.equal(isParallelSafeToolCall(call('goal', { action: 'get' })), true)
    assert.equal(isParallelSafeToolCall(call('goal', { action: 'complete' })), false)
    assert.equal(isParallelSafeToolCall(call('goal', { action: 'report_blocker' })), false)
    assert.equal(isParallelSafeToolCall(call('unknown_future_tool')), false)
  })

  test('classifies deferred invoke by the actual target tool and args', () => {
    assert.equal(isParallelSafeToolCall(call('invoke', {
      tool: 'workspace_file',
      args: { action: 'read', file: 'notes.md' },
    })), true)
    assert.equal(isParallelSafeToolCall(call('invoke', {
      tool: 'workspace_file',
      args: { action: 'delete', file: 'notes.md' },
    })), false)
  })

  test('background fetch and unknown workspace commands remain exclusive', () => {
    assert.equal(isParallelSafeToolCall(call('fetch_content', {
      action: 'url', url: 'https://example.com', background: true,
    })), false)
    assert.equal(isParallelSafeToolCall(call('workspace_bash', {
      cwd: 'workspace', command: 'mystery command',
    })), false)
  })
})
