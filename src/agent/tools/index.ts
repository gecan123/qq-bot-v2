import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { waitTool } from './wait.js'
import { createSendMessageTool } from './send-message.js'
import { dbSchemaTool } from './db-schema.js'
import { dbReadTool } from './db-read.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { fetchRedditTool } from './fetch-reddit.js'
import { fetchUrlTool } from './fetch-url.js'

export interface BotToolDeps {
  sender: MessageSender
  groupIdWhitelist: readonly number[]
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendMessageTool({
      sender: deps.sender,
      groupIdWhitelist: deps.groupIdWhitelist,
    }),
    dbSchemaTool,
    dbReadTool,
    fetchRedditTool,
    fetchUrlTool,
  ]

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  return tools
}
