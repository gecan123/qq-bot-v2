import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { waitTool } from './wait.js'
import { createSendGroupMessageTool } from './send-group-message.js'
import { dbSchemaTool } from './db-schema.js'
import { dbReadTool } from './db-read.js'
import { maybeCreateWebSearchTool } from './web-search.js'

export interface BotToolDeps {
  sender: MessageSender
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendGroupMessageTool({ sender: deps.sender }),
    dbSchemaTool,
    dbReadTool,
  ]

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  return tools
}
