import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { McpManager, type McpServerConfig } from '../mcp-manager.js'
import { createMcpTool } from './mcp.js'

describe('mcp tool', () => {
  test('lists without connecting, then exposes and invokes namespaced tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-bot-mcp-tool-'))
    let connected = 0
    const config: McpServerConfig = {
      command: '/bin/echo',
      args: [],
      env: {},
      inheritEnv: [],
      readOnlyTools: ['search'],
      timeoutMs: 30_000,
      resultMaxChars: 12_000,
    }
    const manager = new McpManager({
      servers: { local: config },
      snapshotDir: dir,
      factory: async () => {
        connected++
        return {
          async listTools() {
            return [{ name: 'search', inputSchema: { type: 'object' } }]
          },
          async callTool(_name, args) {
            return { content: [{ type: 'text', text: String(args.query) }] }
          },
          async close() {},
        }
      },
    })
    const tool = createMcpTool(manager)
    const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

    const servers = await tool.execute({ action: 'servers' }, ctx)
    assert.equal(connected, 0)
    assert.match(String(servers.content), /local/)

    const tools = await tool.execute({ action: 'tools', server: 'local' }, ctx)
    assert.equal(connected, 1)
    assert.match(String(tools.content), /mcp__local__search/)

    const call = await tool.execute({
      action: 'call',
      tool: 'mcp__local__search',
      arguments: { query: 'needle' },
    }, ctx)
    assert.equal(call.outcome?.ok, true)
    assert.match(String(call.content), /needle/)
    await manager.closeAll()
    await rm(dir, { recursive: true, force: true })
  })
})
