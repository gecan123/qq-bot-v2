import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'qq-bot-v2-test-echo', version: '1.0.0' })

server.registerTool('echo', {
  description: 'Echo text from the integration test',
  inputSchema: { text: z.string() },
}, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}` }],
}))

await server.connect(new StdioServerTransport())
