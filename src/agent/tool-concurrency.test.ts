import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createDeferredToolExecutor, type Tool } from './tool.js'
import { isParallelSafeToolCall } from './tool-concurrency.js'
import { applyBotToolPolicy } from './tools/policies.js'

function call(name: string, args: Record<string, unknown> = {}) {
  return { id: 'call-1', name, args }
}

function policyTool(name: string): Tool {
  return applyBotToolPolicy({
    name,
    description: name,
    schema: z.record(z.string(), z.unknown()),
    execute: async () => ({ content: 'unused' }),
  })
}

const tools = createDeferredToolExecutor({
  alwaysOnTools: [
    'inbox',
    'memory',
    'notebook',
    'schedule',
    'goal',
    'fetch_content',
    'workspace_bash',
  ].map(policyTool),
  capabilities: [{
    name: 'workspace_management',
    description: 'workspace files',
    tools: [policyTool('workspace_file')],
  }],
})

describe('tool concurrency policy', () => {
  test('allows only explicit read-only actions', () => {
    assert.equal(isParallelSafeToolCall(tools, call('inbox', { action: 'read' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('memory', { action: 'recall' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('memory', { action: 'delete' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('notebook', { action: 'list' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('notebook', { action: 'search' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('notebook', { action: 'read' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('notebook', { action: 'write' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('schedule', { action: 'list' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('schedule', { action: 'get_occurrence' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('schedule', { action: 'create' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('schedule', { action: 'cancel' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('schedule')), false)
    assert.equal(isParallelSafeToolCall(tools, call('goal', { action: 'get' })), true)
    assert.equal(isParallelSafeToolCall(tools, call('goal', { action: 'complete' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('goal', { action: 'report_blocker' })), false)
    assert.equal(isParallelSafeToolCall(tools, call('unknown_future_tool')), false)
  })

  test('classifies deferred invoke by the actual target tool and args', () => {
    assert.equal(isParallelSafeToolCall(tools, call('invoke', {
      tool: 'workspace_file',
      args: { action: 'read', file: 'notes.md' },
    })), true)
    assert.equal(isParallelSafeToolCall(tools, call('invoke', {
      tool: 'workspace_file',
      args: { action: 'delete', file: 'notes.md' },
    })), false)
  })

  test('background fetch remains exclusive while workspace_bash is always read-only', () => {
    assert.equal(isParallelSafeToolCall(tools, call('fetch_content', {
      action: 'url', url: 'https://example.com', background: true,
    })), false)
    assert.equal(isParallelSafeToolCall(tools, call('workspace_bash', {
      cwd: 'workspace', command: 'mystery command',
    })), true)
  })
})
