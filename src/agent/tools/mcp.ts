import { z } from 'zod'
import type { Tool } from '../tool.js'
import { McpManager, McpManagerError } from '../mcp-manager.js'

const argsSchema = z.object({
  action: z.enum(['servers', 'connect', 'tools', 'call', 'disconnect']),
  server: z.string().trim().min(1).max(64).optional(),
  tool: z.string().trim().min(1).max(180).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  refresh: z.boolean().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10).optional(),
}).superRefine((args, ctx) => {
  if ((args.action === 'connect' || args.action === 'tools' || args.action === 'disconnect') && !args.server) {
    ctx.addIssue({ code: 'custom', path: ['server'], message: `server is required for ${args.action}` })
  }
  if (args.action === 'call' && !args.tool) {
    ctx.addIssue({ code: 'custom', path: ['tool'], message: 'tool is required for call' })
  }
})

type McpToolArgs = z.infer<typeof argsSchema>

export function createMcpTool(manager: McpManager): Tool<McpToolArgs> {
  return {
    name: 'mcp',
    description: [
      '按需连接 operator 配置的 MCP server；未调用 connect/tools/call 前不会启动外部进程.',
      '先 servers 查看配置，再 tools 获取版本化 schema 快照和 mcp__server__tool 名称，最后 call.',
      '只有配置中明确列为 readOnlyTools 的远端工具可直接调用；其余调用需要 owner 审批.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'servers') {
          return {
            content: JSON.stringify({
              ok: true,
              action: 'servers',
              servers: manager.listServers(),
              next: '调用 action=tools server=<name> 才会启动该 MCP server 并读取工具 schema.',
            }),
          }
        }

        if (args.action === 'connect') {
          const connected = await manager.connect(args.server!)
          const { tools, ...server } = connected
          return {
            content: JSON.stringify({
              ok: true,
              action: 'connect',
              server,
              toolPreview: tools.slice(0, 10).map((tool) => ({ name: tool.name, access: tool.access })),
              next: `调用 mcp action=tools server=${server.name} 分页读取参数 schema，再用完整命名空间名称 call.`,
            }),
          }
        }

        if (args.action === 'tools') {
          const result = await manager.listTools(args.server!, args.refresh === true)
          const offset = args.offset ?? 0
          const requestedLimit = args.limit ?? 5
          const tools = result.tools.slice(offset, offset + requestedLimit)
          const nextOffset = offset + tools.length < result.tools.length ? offset + tools.length : null
          const payload = {
            ok: true,
            action: 'tools',
            server: result.server,
            offset,
            total: result.tools.length,
            tools,
            nextOffset,
            next: nextOffset == null
              ? '从 tools[].name 复制完整 mcp__server__tool 名称；不要猜测或使用 remoteName.'
              : `继续调用 mcp action=tools server=${args.server} offset=${nextOffset}.`,
          }
          return {
            content: boundToolsPayload(payload, manager.resultMaxChars(args.server!)),
          }
        }

        if (args.action === 'disconnect') {
          const disconnected = await manager.disconnect(args.server!)
          return {
            content: JSON.stringify({
              ok: true,
              action: 'disconnect',
              server: args.server,
              disconnected,
            }),
          }
        }

        const result = await manager.callTool(args.tool!, args.arguments ?? {})
        return {
          content: result.content,
          outcome: result.isError
            ? { ok: false, code: 'mcp_tool_error', error: `MCP tool reported an error: ${args.tool}` }
            : { ok: true },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof McpManagerError ? error.code : 'mcp_execution_failed'
        return {
          content: JSON.stringify({ ok: false, code, error: message }),
          outcome: { ok: false, code, error: message },
        }
      }
    },
  }
}

function boundToolsPayload(
  payload: {
    ok: boolean
    action: string
    server: unknown
    offset: number
    total: number
    tools: unknown[]
    nextOffset: number | null
    next: string
  },
  maxChars: number,
): string {
  let serialized = JSON.stringify(payload)
  while (serialized.length > maxChars && payload.tools.length > 1) {
    payload.tools.pop()
    payload.nextOffset = payload.offset + payload.tools.length
    payload.next = `结果已按大小缩短；继续调用 mcp action=tools offset=${payload.nextOffset}.`
    serialized = JSON.stringify(payload)
  }
  if (serialized.length <= maxChars) return serialized
  return JSON.stringify({
    ok: false,
    code: 'mcp_schema_result_too_large',
    error: `单个 MCP tool schema 超过当前 ${maxChars} 字符结果上限`,
    offset: payload.offset,
    total: payload.total,
  })
}
