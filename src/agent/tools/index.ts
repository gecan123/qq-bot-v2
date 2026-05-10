import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { waitTool } from './wait.js'
import { createSendMessageTool } from './send-message.js'
import { dbSchemaTool } from './db-schema.js'
import { dbReadTool } from './db-read.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { listRedditTool } from './reddit/list.js'
import { getRedditPostTool } from './reddit/get-post.js'
import { createFetchUrlTool } from './fetch-url.js'

export interface BotToolDeps {
  sender: MessageSender
  /** Group-ambient dry-run 开关. 透传给 send_message tool. 见 SendMessageDeps. */
  groupAmbientDryRun: boolean
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendMessageTool({
      sender: deps.sender,
      groupAmbientDryRun: deps.groupAmbientDryRun,
    }),
    dbSchemaTool,
    dbReadTool,
    listRedditTool,
    getRedditPostTool,
    createFetchUrlTool(),
  ]

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  return tools
}
