import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { waitTool } from './wait.js'
import { createSendMessageTool } from './send-message.js'
import { dbSchemaTool } from './db-schema.js'
import { dbReadTool } from './db-read.js'
import { maybeCreateWebSearchTool } from './web-search.js'

export interface BotToolDeps {
  sender: MessageSender
  groupIdWhitelist: readonly number[]
  privateUserIdWhitelist: readonly number[]
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendMessageTool({
      sender: deps.sender,
      groupIdWhitelist: deps.groupIdWhitelist,
      privateUserIdWhitelist: deps.privateUserIdWhitelist,
    }),
    dbSchemaTool,
    dbReadTool,
  ]

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  return tools
}
