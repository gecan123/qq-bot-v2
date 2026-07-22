import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { z } from 'zod'
import { createApprovalManager } from './approval-manager.js'
import { classifyApprovalRequirement, createOwnerApprovalHook } from './approval-policy.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createDeferredToolExecutor, createToolExecutor, type Tool } from './tool.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-bot-policy-'))
  dirs.push(dir)
  let executed = 0
  const manager = createApprovalManager({
    path: join(dir, 'approvals.json'),
    owner: { qq: 123, name: 'owner' },
    idFactory: () => 'approval-1',
    now: () => new Date('2026-07-12T00:00:00.000Z'),
    loadEvidence: async () => ({
      rowId: 8,
      sceneKind: 'qq_private',
      sceneExternalId: '123',
      senderId: 123n,
      text: '批准 approval-1',
      sentAt: new Date('2026-07-12T00:00:01.000Z'),
    }),
  })
  const memory: Tool = {
    name: 'memory',
    description: 'memory',
    schema: z.object({ action: z.string(), files: z.array(z.string()).optional() }),
    async execute() {
      executed++
      return { content: '{"ok":true}' }
    },
  }
  return { manager, memory, executed: () => executed }
}

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

describe('owner approval policy', () => {
  test('blocks a destructive call, then allows the exact args once after approval', async () => {
    const setupResult = setup()
    const executor = createToolExecutor([setupResult.memory], {
      hooks: { beforeTool: [createOwnerApprovalHook(setupResult.manager, undefined, 'strict')] },
    })
    const call = { id: 'delete-1', name: 'memory', args: { action: 'delete', files: ['a.md'] } }

    const blocked = await executor.execute(call, ctx)
    assert.equal(JSON.parse(String(blocked.content)).code, 'approval_required')
    assert.equal(setupResult.executed(), 0)
    await setupResult.manager.approve({ approvalId: 'approval-1', messageRowId: 8 })

    await executor.execute(call, ctx)
    assert.equal(setupResult.executed(), 1)
    const blockedAgain = await executor.execute(call, ctx)
    assert.equal(JSON.parse(String(blockedAgain.content)).code, 'approval_required')
    assert.equal(setupResult.executed(), 1)
  })

  test('deferred invoke applies the hook to the real internal tool and args', async () => {
    const setupResult = setup()
    const executor = createDeferredToolExecutor({
      alwaysOnTools: [],
      capabilities: [{ name: 'managed', description: 'managed', tools: [setupResult.memory] }],
      hooks: { beforeTool: [createOwnerApprovalHook(setupResult.manager, undefined, 'strict')] },
    })

    const result = await executor.execute({
      id: 'invoke-1',
      name: 'invoke',
      args: { tool: 'memory', args: { action: 'delete', files: ['nested.md'] } },
    }, ctx)

    assert.equal(JSON.parse(String(result.content)).code, 'approval_required')
    assert.equal(setupResult.manager.list()[0]?.toolName, 'memory')
    assert.equal(setupResult.executed(), 0)
  })

  test('classifies only explicitly high-risk destructive actions', () => {
    assert.ok(classifyApprovalRequirement('website', { action: 'publish' }))
    assert.equal(classifyApprovalRequirement('skill_editor', { action: 'install' }), null)
    assert.ok(classifyApprovalRequirement('skill_editor', { action: 'install' }, 'strict'))
    assert.ok(classifyApprovalRequirement('memory', { action: 'delete' }, 'strict'))
    assert.ok(classifyApprovalRequirement('notebook', { action: 'delete' }, 'strict'))
    assert.equal(classifyApprovalRequirement('website', { action: 'publish' }, 'off'), null)
    assert.equal(classifyApprovalRequirement('memory', { action: 'write' }), null)
    assert.equal(classifyApprovalRequirement('send_message', { text: 'hello' }), null)
  })

  test('thin mode does not block local destructive iteration', async () => {
    const setupResult = setup()
    const executor = createToolExecutor([setupResult.memory], {
      hooks: { beforeTool: [createOwnerApprovalHook(setupResult.manager)] },
    })
    const result = await executor.execute({
      id: 'local-delete',
      name: 'memory',
      args: { action: 'delete', files: ['draft.md'] },
    }, ctx)

    assert.equal(JSON.parse(String(result.content)).ok, true)
    assert.equal(setupResult.executed(), 1)
    assert.equal(setupResult.manager.list().length, 0)
  })

  test('accepts an injected classifier for dynamically governed tools such as MCP', async () => {
    const setupResult = setup()
    let executed = 0
    const mcp: Tool = {
      name: 'mcp',
      description: 'mcp',
      schema: z.object({ action: z.string(), tool: z.string() }),
      async execute() {
        executed++
        return { content: '{"ok":true}' }
      },
    }
    const executor = createToolExecutor([mcp], {
      hooks: {
        beforeTool: [createOwnerApprovalHook(setupResult.manager, (toolName, args) => (
          toolName === 'mcp' && (args as { action?: string }).action === 'call'
            ? { reason: 'external MCP call' }
            : null
        ))],
      },
    })
    const result = await executor.execute({
      id: 'mcp-1',
      name: 'mcp',
      args: { action: 'call', tool: 'mcp__local__write' },
    }, ctx)

    assert.equal(JSON.parse(String(result.content)).code, 'approval_required')
    assert.equal(executed, 0)
  })
})
