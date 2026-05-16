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
import { maybeCreateStockQueryTool } from './stock-query.js'
import { createGenerateImageTool } from './generate-image.js'
import { createDownloadImageTool } from './download-image.js'
import { rememberTool } from './remember.js'
import { recallTool } from './recall.js'

export interface BotToolDeps {
  sender: MessageSender
  /** Group-ambient 真发白名单. 透传给 send_message tool. 见 SendMessageDeps. */
  groupAmbientSendIds: ReadonlySet<number>
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendMessageTool({
      sender: deps.sender,
      groupAmbientSendIds: deps.groupAmbientSendIds,
    }),
    dbSchemaTool,
    dbReadTool,
    listRedditTool,
    getRedditPostTool,
    createFetchUrlTool(),
    createGenerateImageTool(),
    createDownloadImageTool(),
    rememberTool,
    recallTool,
  ]

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  const stockQuery = maybeCreateStockQueryTool()
  if (stockQuery) tools.push(stockQuery)

  return tools
}
