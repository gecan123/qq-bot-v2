import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  createMcpManagerFromConfigFile,
  McpManager,
  McpManagerError,
  type McpClientPort,
  type McpServerConfig,
} from './mcp-manager.js'

describe('McpManager', () => {
  test('stays lazy, snapshots namespaced schemas, and applies explicit read-only policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-bot-mcp-'))
    let factoryCalls = 0
    let closeCalls = 0
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const manager = new McpManager({
      servers: { local: makeConfig({ readOnlyTools: ['search'] }) },
      snapshotDir: dir,
      now: () => new Date('2026-07-12T01:02:03.000Z'),
      factory: async () => {
        factoryCalls++
        return {
          serverVersion: { name: 'fixture', version: '1.2.3' },
          async listTools() {
            return [
              {
                name: 'remove item',
                description: 'delete an item',
                inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
                annotations: { destructiveHint: true },
              },
              {
                name: 'search',
                description: 'find items',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                annotations: { readOnlyHint: true },
              },
              {
                name: 'two__parts',
                description: 'name contains the namespace delimiter',
                inputSchema: { type: 'object' },
              },
            ]
          },
          async callTool(name, args) {
            calls.push({ name, args })
            return { content: [{ type: 'text', text: `found ${String(args.query ?? '')}` }] }
          },
          async close() {
            closeCalls++
          },
        }
      },
    })

    assert.equal(factoryCalls, 0)
    assert.deepEqual(manager.listServers().map((item) => ({ name: item.name, connected: item.connected })), [
      { name: 'local', connected: false },
    ])

    const listed = await manager.listTools('local')
    assert.equal(factoryCalls, 1)
    assert.deepEqual(listed.tools.map((tool) => [tool.name, tool.access]), [
      ['mcp__local__remove_item', 'approval_required'],
      ['mcp__local__search', 'read_only'],
      ['mcp__local__two__parts', 'approval_required'],
    ])
    assert.equal(manager.approvalRequirementForArgs({
      action: 'call',
      tool: 'mcp__local__search',
    }), null)
    assert.match(manager.approvalRequirementForArgs({
      action: 'call',
      tool: 'mcp__local__remove_item',
    })?.reason ?? '', /remove_item/)

    const result = await manager.callTool('mcp__local__search', { query: 'hello' })
    assert.equal(result.isError, false)
    assert.match(result.content, /found hello/)
    assert.deepEqual(calls, [{ name: 'search', args: { query: 'hello' } }])
    await manager.callTool('mcp__local__two__parts', {})
    assert.equal(calls[1]?.name, 'two__parts')

    const snapshot = JSON.parse(await readFile(join(dir, 'local.json'), 'utf8'))
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.server, 'local')
    assert.equal(snapshot.capturedAt, '2026-07-12T09:02:03.000+08:00')
    assert.match(snapshot.schemaVersion, /^[a-f0-9]{16}$/)
    assert.equal(snapshot.tools[1].name, 'mcp__local__search')

    assert.equal(await manager.disconnect('local'), true)
    assert.equal(closeCalls, 1)
    await rm(dir, { recursive: true, force: true })
  })

  test('deduplicates concurrent first connections and bounds binary-heavy results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-bot-mcp-'))
    let factoryCalls = 0
    const client: McpClientPort = {
      async listTools() {
        return [{ name: 'blob', inputSchema: { type: 'object' } }]
      },
      async callTool() {
        return { content: [{ type: 'image', data: 'a'.repeat(10_000), mimeType: 'image/png' }] }
      },
      async close() {},
    }
    const manager = new McpManager({
      servers: { local: makeConfig({ resultMaxChars: 1_000 }) },
      snapshotDir: dir,
      factory: async () => {
        factoryCalls++
        await new Promise((resolve) => setTimeout(resolve, 5))
        return client
      },
    })

    await Promise.all([manager.connect('local'), manager.listTools('local')])
    assert.equal(factoryCalls, 1)
    const result = await manager.callTool('mcp__local__blob', {})
    assert.ok(result.content.length <= 1_000)
    assert.doesNotThrow(() => JSON.parse(result.content))
    assert.match(result.content, /binary omitted/)
    await manager.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  test('loads relative cwd from a versioned config and rejects invalid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-bot-mcp-config-'))
    const path = join(dir, 'servers.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      servers: {
        local: {
          command: '/bin/echo',
          cwd: './workspace',
          readOnlyTools: ['search'],
        },
      },
    }))
    let captured: McpServerConfig | undefined
    const manager = createMcpManagerFromConfigFile({
      path,
      snapshotDir: join(dir, 'snapshots'),
      factory: async (_name, config) => {
        captured = config
        return {
          async listTools() { return [] },
          async callTool() { return {} },
          async close() {},
        }
      },
    })
    await manager.connect('local')
    assert.equal(captured?.cwd, join(dir, 'workspace'))
    assert.deepEqual(captured?.args, [])

    await writeFile(path, JSON.stringify({ version: 2, servers: {} }))
    assert.throws(
      () => createMcpManagerFromConfigFile({ path }),
      (error: unknown) => error instanceof McpManagerError && error.code === 'invalid_config',
    )
    await manager.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  test('connects to a real local stdio server through the official SDK and closes it', { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-bot-mcp-sdk-'))
    const fixture = fileURLToPath(new URL('./test-fixtures/mcp-echo-server.ts', import.meta.url))
    const manager = new McpManager({
      servers: {
        echo: makeConfig({
          command: process.execPath,
          args: ['--import', 'tsx', fixture],
          cwd: process.cwd(),
          readOnlyTools: ['echo'],
          timeoutMs: 5_000,
        }),
      },
      snapshotDir: dir,
    })

    try {
      const listed = await manager.listTools('echo')
      assert.deepEqual(listed.tools.map((tool) => tool.name), ['mcp__echo__echo'])
      const result = await manager.callTool('mcp__echo__echo', { text: 'hello' })
      assert.match(result.content, /echo:hello/)
    } finally {
      await manager.closeAll()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    command: '/bin/echo',
    args: [],
    env: {},
    inheritEnv: [],
    readOnlyTools: [],
    timeoutMs: 30_000,
    resultMaxChars: 12_000,
    ...overrides,
  }
}
