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
import { maybeCreateWebsiteTool } from './website.js'
import { createFetchContentTool } from './fetch-content.js'
import { createInboxTool } from './inbox.js'
import { createChatStyleTool } from './chat-style.js'
import { createAiToneTool } from './ai-tone.js'
import { journalTool } from './journal.js'
import { lifeJournalTool } from './life-journal.js'
import { skillEditorTool } from './skill-editor.js'
import { workspaceFileTool } from './workspace-file.js'
import { createReadFileTool } from './read-file.js'
import type { SendTargetPolicy } from '../send-target-policy.js'

export interface BotToolDeps {
  sender: MessageSender
  targetPolicy: SendTargetPolicy
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  selfNumber: number
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
  websiteTool?: Tool
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
      targetPolicy: deps.targetPolicy,
    }),
    createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),
    todoTool,
    skillTool,
    memoryTool,
    createInboxTool({ groupIds: deps.groupIds, selfNumber: deps.selfNumber }),
    collectStickerTool,
    createChatStyleTool({
      groupIds: deps.groupIds,
      metadata: deps.metadata,
      groupCustomizations: deps.groupCustomizations,
    }),
    createAiToneTool(),
    journalTool,
    lifeJournalTool,
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

  const website = deps.websiteTool ?? maybeCreateWebsiteTool()
  if (website) {
    capabilities.push({
      name: 'website',
      description: 'Luna 个人网站维护: 读取、写入、删除和移动 Astro 内容文件, 构建检查, commit 并 push 到配置分支.',
      tools: [website],
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
      name: 'workspace_management',
      description: '普通私有工作文件: 分页读取、创建、覆盖、精确替换、删除和移动; 包括持续维护 notes/wishes.md 愿望清单.',
      tools: [workspaceFileTool],
    },
    {
      name: 'document_reading',
      description: '读取 QQ 收到的文件: 从 inbox 的 file mediaId 提取纯文本、PDF、Office 或 OpenDocument 内容并分页查看.',
      tools: [createReadFileTool()],
    },
    {
      name: 'skill_management',
      description: '运行时 skill 草稿的创建、删除、校验和安装.',
      tools: [skillEditorTool],
    },
    {
      name: 'media_generation',
      description: 'AI 图片生成和基于已有图片的编辑.',
      tools: [createGenerateImageTool({ taskRegistry: deps.taskRegistry })],
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
