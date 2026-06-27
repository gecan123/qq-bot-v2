import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import type { GroupCustomization } from '../../config/group-prompts.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { pauseTool } from './pause.js'
import { createSendMessageTool } from './send-message.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { createGenerateImageTool } from './generate-image.js'
import { createBackgroundTaskTool } from './background-task.js'
import { memoryTool } from './memory.js'
import { skillTool } from './skill.js'
import { todoTool } from './todo.js'
import { collectStickerTool } from './collect-sticker.js'
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
    pauseTool,
    createSendMessageTool({
      sender: deps.sender,
      groupAmbientSendIds: deps.groupAmbientSendIds,
    }),
    createGenerateImageTool({ taskRegistry: deps.taskRegistry }),
    createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),
    todoTool,
    skillTool,
    memoryTool,
    collectStickerTool,
    createWorkspaceBashTool({
      groupIdWhitelist: deps.groupIds,
      groupIds: deps.groupIds,
      metadata: deps.metadata,
      groupCustomizations: deps.groupCustomizations,
    }),
  ]

  const browser = maybeCreateBrowserTool()
  if (browser) tools.push(browser)

  const webSearch = maybeCreateWebSearchTool()
  if (webSearch) tools.push(webSearch)

  return tools
}
