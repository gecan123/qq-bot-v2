import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('MCP_MANAGER')

const DEFAULT_RESULT_MAX_CHARS = 12_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REMOTE_TOOLS = 200
const MAX_LIST_PAGES = 20
const MAX_SCHEMA_CHARS = 4_000
const MAX_SNAPSHOT_CHARS = 2_000_000

const serverConfigSchema = z.object({
  command: z.string().trim().min(1).max(1_000),
  args: z.array(z.string().max(4_000)).max(100).default([]),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  inheritEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
  readOnlyTools: z.array(z.string().trim().min(1).max(240)).max(MAX_REMOTE_TOOLS).default([]),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS),
  resultMaxChars: z.number().int().min(6_000).max(50_000).default(DEFAULT_RESULT_MAX_CHARS),
})

const configFileSchema = z.object({
  version: z.literal(1),
  servers: z.record(
    z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    serverConfigSchema,
  ).refine((servers) => Object.keys(servers).length <= 50, 'at most 50 MCP servers are allowed'),
})

export type McpServerConfig = z.infer<typeof serverConfigSchema>

export interface McpRemoteTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpClientPort {
  listTools(): Promise<McpRemoteTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
  serverVersion?: { name: string; version: string }
}

export type McpClientFactory = (
  serverName: string,
  config: McpServerConfig,
) => Promise<McpClientPort>

export interface McpToolDescriptor {
  name: string
  remoteName: string
  description: string
  inputSchema: Record<string, unknown>
  access: 'read_only' | 'approval_required'
  remoteAnnotations?: McpRemoteTool['annotations']
}

export interface McpServerStatus {
  name: string
  connected: boolean
  command: string
  toolCount?: number
  schemaVersion?: string
  serverVersion?: { name: string; version: string }
}

interface ConnectedServer {
  client: McpClientPort
  tools: McpToolDescriptor[]
  toolByExposedName: Map<string, McpToolDescriptor>
  schemaVersion: string
}

export interface McpManagerOptions {
  servers: Readonly<Record<string, McpServerConfig>>
  snapshotDir?: string
  factory?: McpClientFactory
  now?: () => Date
}

export class McpManagerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'McpManagerError'
  }
}

export class McpManager {
  private readonly servers: Map<string, McpServerConfig>
  private readonly snapshotDir: string
  private readonly factory: McpClientFactory
  private readonly now: () => Date
  private readonly connections = new Map<string, ConnectedServer>()
  private readonly connecting = new Map<string, Promise<ConnectedServer>>()

  constructor(options: McpManagerOptions) {
    this.servers = new Map(Object.entries(options.servers))
    this.snapshotDir = resolve(options.snapshotDir ?? 'data/agent-workspace/runtime/mcp-schemas')
    this.factory = options.factory ?? createSdkMcpClient
    this.now = options.now ?? (() => new Date())
  }

  hasServers(): boolean {
    return this.servers.size > 0
  }

  listServers(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, config]) => {
      const connected = this.connections.get(name)
      return {
        name,
        connected: !!connected,
        command: basename(config.command),
        ...(connected ? {
          toolCount: connected.tools.length,
          schemaVersion: connected.schemaVersion,
          serverVersion: connected.client.serverVersion ? {
            name: clampText(connected.client.serverVersion.name, 160),
            version: clampText(connected.client.serverVersion.version, 80),
          } : undefined,
        } : {}),
      }
    })
  }

  resultMaxChars(serverName: string): number {
    return this.requireServer(serverName).resultMaxChars
  }

  async connect(serverName: string): Promise<McpServerStatus & { tools: McpToolDescriptor[] }> {
    const connected = await this.getOrConnect(serverName)
    const status = this.listServers().find((server) => server.name === serverName)
    if (!status) throw new McpManagerError('unknown_server', `Unknown MCP server: ${serverName}`)
    return { ...status, tools: connected.tools }
  }

  async listTools(serverName: string, refresh = false): Promise<{
    server: McpServerStatus
    tools: McpToolDescriptor[]
  }> {
    const connected = await this.getOrConnect(serverName)
    if (refresh) await this.refreshTools(serverName, connected)
    const server = this.listServers().find((item) => item.name === serverName)
    if (!server) throw new McpManagerError('unknown_server', `Unknown MCP server: ${serverName}`)
    return { server, tools: connected.tools }
  }

  async callTool(exposedName: string, args: Record<string, unknown>): Promise<{
    content: string
    isError: boolean
  }> {
    const serverName = this.serverNameForTool(exposedName)
    if (!serverName) {
      throw new McpManagerError('invalid_tool_name', 'MCP tool name must use mcp__<server>__<tool>')
    }
    const connected = await this.getOrConnect(serverName)
    const tool = connected.toolByExposedName.get(exposedName)
    if (!tool) {
      throw new McpManagerError('unknown_tool', `Unknown MCP tool: ${exposedName}; call mcp action=tools first`)
    }
    const config = this.requireServer(serverName)
    const result = await connected.client.callTool(tool.remoteName, args)
    const isError = readBooleanField(result, 'isError')
    return {
      content: formatBoundedToolResult({
        tool: exposedName,
        remoteTool: tool.remoteName,
        result,
        isError,
      }, config.resultMaxChars),
      isError,
    }
  }

  approvalRequirementForArgs(args: unknown): { reason: string } | null {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null
    const raw = args as Record<string, unknown>
    if (raw.action !== 'call' || typeof raw.tool !== 'string') return null
    const serverName = this.serverNameForTool(raw.tool)
    const tool = serverName ? this.connections.get(serverName)?.toolByExposedName.get(raw.tool) : undefined
    if (tool?.access === 'read_only') return null
    return { reason: `调用外部 MCP 工具 ${raw.tool}` }
  }

  async disconnect(serverName: string): Promise<boolean> {
    this.requireServer(serverName)
    const pending = this.connecting.get(serverName)
    const connected = this.connections.get(serverName) ?? (pending ? await pending.catch(() => undefined) : undefined)
    this.connecting.delete(serverName)
    this.connections.delete(serverName)
    if (!connected) return false
    await connected.client.close()
    return true
  }

  async closeAll(): Promise<void> {
    const names = [...this.servers.keys()]
    await Promise.allSettled(names.map((name) => this.disconnect(name)))
  }

  private requireServer(serverName: string): McpServerConfig {
    const config = this.servers.get(serverName)
    if (!config) throw new McpManagerError('unknown_server', `Unknown MCP server: ${serverName}`)
    return config
  }

  private serverNameForTool(toolName: string): string | null {
    const matches = [...this.servers.keys()]
      .filter((serverName) => toolName.startsWith(`mcp__${serverName}__`))
      .sort((left, right) => right.length - left.length)
    return matches[0] ?? null
  }

  private async getOrConnect(serverName: string): Promise<ConnectedServer> {
    const existing = this.connections.get(serverName)
    if (existing) return existing
    const pending = this.connecting.get(serverName)
    if (pending) return pending
    const config = this.requireServer(serverName)
    const promise = this.factory(serverName, config)
      .then(async (client) => {
        try {
          const connected: ConnectedServer = {
            client,
            tools: [],
            toolByExposedName: new Map(),
            schemaVersion: '',
          }
          await this.refreshTools(serverName, connected)
          this.connections.set(serverName, connected)
          return connected
        } catch (error) {
          await client.close().catch(() => {})
          throw error
        }
      })
      .finally(() => this.connecting.delete(serverName))
    this.connecting.set(serverName, promise)
    return promise
  }

  private async refreshTools(serverName: string, connected: ConnectedServer): Promise<void> {
    const config = this.requireServer(serverName)
    const remoteTools = await connected.client.listTools()
    if (remoteTools.length > MAX_REMOTE_TOOLS) {
      throw new McpManagerError('too_many_tools', `MCP server ${serverName} exposed more than ${MAX_REMOTE_TOOLS} tools`)
    }
    const tools = normalizeTools(serverName, config, remoteTools)
    const versionInput = JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      remoteName: tool.remoteName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      access: tool.access,
    })))
    const schemaVersion = createHash('sha256').update(versionInput).digest('hex').slice(0, 16)
    connected.tools = tools
    connected.toolByExposedName = new Map(tools.map((tool) => [tool.name, tool]))
    connected.schemaVersion = schemaVersion
    await this.writeSnapshot(serverName, connected).catch((error) => {
      log.warn({ error, serverName }, 'mcp_schema_snapshot_write_failed')
    })
  }

  private async writeSnapshot(serverName: string, connected: ConnectedServer): Promise<void> {
    const snapshot = JSON.stringify({
      version: 1,
      server: serverName,
      capturedAt: formatBeijingIso(this.now()),
      schemaVersion: connected.schemaVersion,
      serverVersion: connected.client.serverVersion,
      tools: connected.tools,
    }, null, 2)
    if (snapshot.length > MAX_SNAPSHOT_CHARS) {
      throw new McpManagerError('snapshot_too_large', `MCP schema snapshot exceeds ${MAX_SNAPSHOT_CHARS} chars`)
    }
    await mkdir(this.snapshotDir, { recursive: true })
    const destination = join(this.snapshotDir, `${serverName}.json`)
    const temporary = join(this.snapshotDir, `.${serverName}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${snapshot}\n`, 'utf8')
    await rename(temporary, destination)
  }
}

export function loadMcpConfigFile(path: string): Record<string, McpServerConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new McpManagerError('config_read_failed', `Unable to read MCP config ${path}: ${message}`)
  }
  const parsed = configFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new McpManagerError(
      'invalid_config',
      `Invalid MCP config ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    )
  }
  const baseDir = dirname(resolve(path))
  return Object.fromEntries(Object.entries(parsed.data.servers).map(([name, config]) => [name, {
    ...config,
    ...(config.cwd ? { cwd: resolve(baseDir, config.cwd) } : {}),
  }]))
}

export function createMcpManagerFromConfigFile(options: {
  path: string
  snapshotDir?: string
  factory?: McpClientFactory
  now?: () => Date
}): McpManager {
  return new McpManager({
    servers: loadMcpConfigFile(options.path),
    snapshotDir: options.snapshotDir,
    factory: options.factory,
    now: options.now,
  })
}

async function createSdkMcpClient(serverName: string, config: McpServerConfig): Promise<McpClientPort> {
  const env = { ...getDefaultEnvironment() }
  for (const name of config.inheritEnv) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, config.env)

  const client = new Client({ name: `qq-bot-v2-${serverName}`, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.byteLength(chunk)
    if (bytes > 0) log.info({ serverName, bytes }, 'mcp_server_stderr_observed')
  })
  client.onerror = (error) => log.warn({ error, serverName }, 'mcp_client_transport_error')
  await client.connect(transport)

  return {
    serverVersion: client.getServerVersion(),
    async listTools() {
      const tools: McpRemoteTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.timeoutMs })
        for (const tool of response.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })
          if (tools.length > MAX_REMOTE_TOOLS) return tools
        }
        cursor = response.nextCursor
        if (!cursor) return tools
      }
      throw new McpManagerError('too_many_pages', `MCP server ${serverName} tools/list exceeded ${MAX_LIST_PAGES} pages`)
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args }, undefined, { timeout: config.timeoutMs })
    },
    async close() {
      await client.close()
    },
  }
}

function normalizeTools(
  serverName: string,
  config: McpServerConfig,
  remoteTools: McpRemoteTool[],
): McpToolDescriptor[] {
  const readOnly = new Set(config.readOnlyTools)
  const usedNames = new Set<string>()
  const usedRemoteNames = new Set<string>()
  return [...remoteTools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      if (!tool.name.trim() || tool.name.length > 240) {
        throw new McpManagerError('invalid_remote_tool', `MCP server ${serverName} exposed an invalid tool name`)
      }
      if (usedRemoteNames.has(tool.name)) {
        throw new McpManagerError('duplicate_remote_tool', `MCP server ${serverName} exposed duplicate tool ${tool.name}`)
      }
      usedRemoteNames.add(tool.name)
      const baseName = createNamespacedToolName(serverName, tool.name)
      let name = baseName
      if (usedNames.has(name)) {
        const suffix = createHash('sha256').update(tool.name).digest('hex').slice(0, 8)
        name = `${baseName}_${suffix}`
      }
      usedNames.add(name)
      return {
        name,
        remoteName: tool.name,
        description: clampText(tool.description ?? '', 1_000),
        inputSchema: boundedSchema(tool.inputSchema),
        access: readOnly.has(tool.name) ? 'read_only' : 'approval_required',
        remoteAnnotations: tool.annotations,
      }
    })
}

export function createNamespacedToolName(serverName: string, remoteName: string): string {
  const normalized = remoteName
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'tool'
  return `mcp__${serverName}__${normalized}`
}

function boundedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(schema)
  if (serialized.length <= MAX_SCHEMA_CHARS) return schema
  return {
    type: 'object',
    description: `[schema omitted: ${serialized.length} chars exceeds ${MAX_SCHEMA_CHARS}]`,
  }
}

function formatBoundedToolResult(input: {
  tool: string
  remoteTool: string
  result: unknown
  isError: boolean
}, maxChars: number): string {
  const sanitized = sanitizeRemoteValue(input.result, 0)
  const full = JSON.stringify({
    ok: !input.isError,
    tool: input.tool,
    remoteTool: input.remoteTool,
    isError: input.isError,
    result: sanitized,
  })
  if (full.length <= maxChars) return full
  const summary = {
    ok: !input.isError,
    tool: input.tool,
    remoteTool: input.remoteTool,
    isError: input.isError,
    truncated: true,
    originalChars: full.length,
    resultPreview: '',
  }
  const overhead = JSON.stringify(summary).length
  summary.resultPreview = full.slice(0, Math.max(0, maxChars - overhead - 8))
  const bounded = JSON.stringify(summary)
  if (bounded.length <= maxChars) return bounded
  summary.resultPreview = ''
  return JSON.stringify(summary)
}

function sanitizeRemoteValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return clampText(value, 10_000)
  if (typeof value !== 'object') return String(value)
  if (depth >= 8) return '[max depth]'
  if (Array.isArray(value)) {
    const output = value.slice(0, 100).map((item) => sanitizeRemoteValue(item, depth + 1))
    if (value.length > 100) output.push(`[${value.length - 100} more items]`)
    return output
  }
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record).slice(0, 100)) {
    if ((key === 'data' || key === 'blob') && typeof child === 'string' && child.length > 1_000) {
      output[key] = `[binary omitted: ${child.length} chars]`
    } else {
      output[key] = sanitizeRemoteValue(child, depth + 1)
    }
  }
  if (Object.keys(record).length > 100) output.__truncatedKeys = Object.keys(record).length - 100
  return output
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 40))}\n[...truncated ${value.length - maxChars} chars]`
}

function readBooleanField(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>)[key] === true
}
