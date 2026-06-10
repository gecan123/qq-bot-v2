import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import type { GroupCustomization } from '../../config/group-prompts.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { waitTool } from './wait.js'
import { createSendMessageTool } from './send-message.js'
import { createDbTool } from './db.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { redditTool } from './reddit.js'
import { createFetchUrlTool } from './fetch-url.js'
import { maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { createGenerateImageTool } from './generate-image.js'
import { createBackgroundTaskTool } from './background-task.js'
import { memoryTool } from './memory.js'
import { writeJournalTool } from './write-journal.js'
import { collectStickerTool } from './collect-sticker.js'
import { fetchImageTool } from './fetch-image.js'
import { styleGuideTool } from './style-guide.js'
import { createSourceProfileTool } from './source-profile.js'
import { createWorkspaceBashTool } from './workspace-bash.js'
import { maybeCreateBrowserTool } from './browser.js'

export interface BotToolDeps {
  sender: MessageSender
  /** Group-ambient 真发白名单. 透传给 send_message tool. 见 SendMessageDeps. */
  groupAmbientSendIds: ReadonlySet<number>
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const tools: Tool[] = [
    waitTool,
    createSendMessageTool({
      sender: deps.sender,
      groupAmbientSendIds: deps.groupAmbientSendIds,
    }),
    createDbTool({ groupIdWhitelist: deps.groupIds }),
    redditTool,
    createFetchUrlTool(),
    createGenerateImageTool({ taskRegistry: deps.taskRegistry }),
    fetchImageTool,
    styleGuideTool,
    createSourceProfileTool({
      groupIds: deps.groupIds,
      metadata: deps.metadata,
      groupCustomizations: deps.groupCustomizations,
    }),
    createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),
    memoryTool,
    writeJournalTool,
    collectStickerTool,
    createWorkspaceBashTool(),
  ]

  const browser = maybeCreateBrowserTool()
  if (browser) tools.push(browser)

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  const openbbCli = maybeCreateOpenbbCliTool()
  if (openbbCli) tools.push(openbbCli)

  return tools
}
