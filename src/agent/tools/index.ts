import { createDeferredToolExecutor, type DeferredToolCapability, type Tool } from '../tool.js'
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
import { maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { createFetchContentTool } from './fetch-content.js'

export interface BotToolDeps {
  sender: MessageSender
  /** Group-ambient 真发白名单. 透传给 send_message tool. 见 SendMessageDeps. */
  groupAmbientSendIds: ReadonlySet<number>
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
}

export interface BotToolManifest {
  alwaysOnTools: Tool[]
  capabilities: DeferredToolCapability[]
}

export function buildBotToolManifest(deps: BotToolDeps): BotToolManifest {
  const fetchContent = createFetchContentTool()
  const tools: Tool[] = [
    pauseTool,
    createSendMessageTool({
      sender: deps.sender,
      groupAmbientSendIds: deps.groupAmbientSendIds,
    }),
    createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),
    todoTool,
    skillTool,
    memoryTool,
    createWorkspaceBashTool({
      groupIdWhitelist: deps.groupIds,
      groupIds: deps.groupIds,
      metadata: deps.metadata,
      groupCustomizations: deps.groupCustomizations,
    }),
  ]
  const capabilities: DeferredToolCapability[] = []

  const browser = maybeCreateBrowserTool()
  if (browser) {
    capabilities.push({
      name: 'browser',
      description: '真实浏览器操作: 打开网页、观察页面、点击、输入、截图、下载和请求主人协助.',
      tools: [browser],
    })
  }

  const openbb = maybeCreateOpenbbCliTool()
  if (openbb) {
    capabilities.push({
      name: 'finance',
      description: 'OpenBB CLI 金融数据查询.',
      tools: [openbb],
    })
  }

  const webSearch = maybeCreateWebSearchTool()
  capabilities.push({
    name: 'external_research',
    description: '外部内容与研究: 搜索互联网、抓普通网页、Reddit、图片 URL 和 QQ 头像.',
    tools: webSearch ? [webSearch, fetchContent] : [fetchContent],
  })

  capabilities.push(
    {
      name: 'media_generation',
      description: 'AI 图片生成和基于已有图片的编辑.',
      tools: [createGenerateImageTool({ taskRegistry: deps.taskRegistry })],
    },
    {
      name: 'media_library',
      description: '表情包池收藏、列表、搜索和随机候选.',
      tools: [collectStickerTool],
    },
    {
      name: 'media_fetch',
      description: '下载图片 URL 或 QQ 头像, 生成可发送、编辑或收藏的 image handle.',
      tools: [fetchContent],
    },
  )

  return { alwaysOnTools: tools, capabilities }
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const manifest = buildBotToolManifest(deps)
  return createDeferredToolExecutor(manifest).list()
}
