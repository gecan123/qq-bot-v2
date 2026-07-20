import { createDeferredToolExecutor, type DeferredToolCapability, type Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import type { GroupPolicy } from '../../config/group-policies.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { createPauseTool } from './pause.js'
import { createSendMessageTool } from './send-message.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { createGenerateImageTool } from './generate-image.js'
import { createBackgroundTaskTool } from './background-task.js'
import { createMemoryTool } from './memory.js'
import { skillTool } from './skill.js'
import { todoTool } from './todo.js'
import { collectStickerTool } from './collect-sticker.js'
import { createWorkspaceBashTool } from './workspace-bash.js'
import { maybeCreateBrowserTool } from './browser.js'
import { maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { maybeCreateWebsiteTool } from './website.js'
import { createFetchContentTool, fetchContentScopeAccepts } from './fetch-content.js'
import { createInboxTool } from './inbox.js'
import { createChatStyleTool } from './chat-style.js'
import { createAiToneTool } from './ai-tone.js'
import { createNotebookTool } from './notebook.js'
import { createLifeJournalTool } from './life-journal.js'
import { skillEditorTool } from './skill-editor.js'
import { workspaceFileTool } from './workspace-file.js'
import { createReadFileTool } from './read-file.js'
import { createInspectMediaTool } from './inspect-media.js'
import { maybeCreateCryptoPaperTool } from './crypto-paper.js'
import { maybeCreateTradingAgentTool } from './trading-agent.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import { createAgentTaskScheduler, type TaskScheduler } from '../task-scheduler.js'
import { createQqDirectoryTool, type QqDirectoryDeps } from './qq-directory.js'
import { createScheduleTool } from './schedule.js'
import type { ScheduleRuntime } from '../schedule-runtime.js'
import type { LlmClient } from '../llm-client.js'
import { createDelegateTool } from './delegate.js'
import type { ApprovalManager } from '../approval-manager.js'
import { createApprovalTool } from './approval.js'
import type { McpManager } from '../mcp-manager.js'
import { createMcpTool } from './mcp.js'
import { createGoalTool } from './goal.js'
import type { GoalStore } from '../goal-store.js'
import type { MemoryMaintenanceRuntime } from '../memory-maintenance.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import type { LoadMemorySourceEvidence } from '../memory-evidence.js'
import { createQqConversationTool, type QqConversationController } from './qq-conversation.js'
import { applyBotToolPolicy } from './policies.js'
import type { InboxReadCursors } from '../inbox-read-cursors.js'

export interface BotToolDeps {
  sender: MessageSender
  targetPolicy: SendTargetPolicy
  conversations: QqConversationController
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  selfNumber: number
  getInboxReadCursors?: () => Readonly<InboxReadCursors>
  metadata: TargetMetadataMaps
  groupPolicies: readonly GroupPolicy[]
  qqDirectory: QqDirectoryDeps
  optionalTools?: BotOptionalTools
  taskScheduler?: TaskScheduler
  scheduleRuntime: ScheduleRuntime
  llm?: LlmClient
  approvalManager?: ApprovalManager
  mcpManager?: McpManager
  goalStore?: GoalStore
  memoryMaintenance?: MemoryMaintenanceRuntime
  workspaceDir?: string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
  loadMemorySourceEvidence?: LoadMemorySourceEvidence
  ownerId?: string
}

export interface BotOptionalTools {
  browser?: Tool | null
  openbb?: Tool | null
  tradingAgent?: Tool | null
  website?: Tool | null
  webSearch?: Tool | null
  cryptoPaper?: Tool | null
}

export interface BotToolManifest {
  alwaysOnTools: Tool[]
  capabilities: DeferredToolCapability[]
}

export function buildBotToolManifest(deps: BotToolDeps): BotToolManifest {
  const taskScheduler = deps.taskScheduler ?? createAgentTaskScheduler()
  const externalResearchFetchContent = createFetchContentTool({
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    scope: 'external_research',
  })
  const mediaFetchContent = createFetchContentTool({
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    scope: 'media_fetch',
  })
  const cryptoPaper = resolveOptionalTool(deps.optionalTools, 'cryptoPaper', maybeCreateCryptoPaperTool)
  const tradingAgent = resolveOptionalTool(
    deps.optionalTools,
    'tradingAgent',
    () => maybeCreateTradingAgentTool({ taskRegistry: deps.taskRegistry }) ?? null,
  )
  const qqDirectory = createQqDirectoryTool(deps.qqDirectory)
  const qqConversation = createQqConversationTool(deps.conversations)
  const sendMessage = createSendMessageTool({
    sender: deps.sender,
    targetPolicy: deps.targetPolicy,
    conversations: deps.conversations,
  })
  const backgroundTask = createBackgroundTaskTool({ taskRegistry: deps.taskRegistry })
  const inbox = createInboxTool({
    groupIds: deps.groupIds,
    selfNumber: deps.selfNumber,
    ...(deps.getInboxReadCursors ? { getReadCursors: deps.getInboxReadCursors } : {}),
  })
  const chatStyle = createChatStyleTool({
    groupIds: deps.groupIds,
    metadata: deps.metadata,
    groupPolicies: deps.groupPolicies,
  })
  const aiTone = createAiToneTool()
  const pause = createPauseTool()
  const schedule = createScheduleTool(deps.scheduleRuntime)
  const notebook = createNotebookTool({
    rootDir: deps.workspaceDir,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  })
  const lifeJournal = createLifeJournalTool({
    rootDir: deps.workspaceDir,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  })
  const collectSticker = collectStickerTool
  const workspaceBash = createWorkspaceBashTool({
    groupIdWhitelist: deps.groupIds,
    groupIds: deps.groupIds,
    metadata: deps.metadata,
    groupPolicies: deps.groupPolicies,
  })
  const delegate = deps.llm ? createDelegateTool({
    llm: deps.llm,
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    safeTools: [workspaceBash, inbox, qqDirectory, chatStyle, aiTone, skillTool, backgroundTask],
  }) : null
  const tools: Tool[] = [
    pause,
    qqDirectory,
    backgroundTask,
    ...(delegate ? [delegate] : []),
    ...(deps.approvalManager ? [createApprovalTool(deps.approvalManager)] : []),
    ...(deps.goalStore ? [createGoalTool(deps.goalStore)] : []),
    todoTool,
    skillTool,
    createMemoryTool({
      workspaceDir: deps.workspaceDir,
      maintenance: deps.memoryMaintenance,
      workspaceStateCoordinator: deps.workspaceStateCoordinator,
      loadSourceEvidence: deps.loadMemorySourceEvidence,
      ownerId: deps.ownerId,
    }),
    inbox,
    chatStyle,
    aiTone,
    ...(cryptoPaper ? [cryptoPaper] : []),
    workspaceBash,
  ]
  const capabilities: DeferredToolCapability[] = []

  capabilities.push({
    name: 'qq',
    description: 'QQ 会话导航与发送；先打开当前会话，再通过 invoke 发送文本、图片或音乐.',
    tools: [qqConversation, sendMessage],
  })

  capabilities.push(
    {
      name: 'short_term_scheduling',
      description: '未来三天内的一次性或短周期重新唤醒；scheduled wake 只是重新评估信号，不用于等回复或机械轮询.',
      tools: [schedule],
    },
    {
      name: 'life_state',
      description: '跨天主题过程、经历、感受、梦和当前 Agenda；稳定事实仍写 memory.',
      tools: [notebook, lifeJournal],
    },
    {
      name: 'sticker_management',
      description: '收藏、搜索、随机选择或移除 QQ 表情包候选.',
      tools: [collectSticker],
    },
  )

  if (deps.mcpManager?.hasServers()) {
    capabilities.push({
      name: 'mcp_connectors',
      description: '按需连接 operator 配置的 MCP server；提供命名空间工具、版本化 schema 快照、结果上限和 owner 审批.',
      tools: [createMcpTool(deps.mcpManager)],
    })
  }

  const browser = resolveOptionalTool(deps.optionalTools, 'browser', maybeCreateBrowserTool)
  if (browser) {
    capabilities.push({
      name: 'browser',
      description: '真实浏览器操作: 打开网页、观察页面、点击、输入、截图、下载和请求主人协助.',
      tools: [browser],
    })
  }

  const openbb = resolveOptionalTool(deps.optionalTools, 'openbb', maybeCreateOpenbbCliTool)
  if (openbb) {
    capabilities.push({
      name: 'finance',
      description: 'OpenBB CLI 金融数据查询.',
      tools: [openbb],
    })
  }

  if (tradingAgent) {
    capabilities.push({
      name: 'trading_research',
      description: '有具体金融问题且需要跨来源证据、可复现策略规则或历史回测时，委派给本机 Vibe-Trading 子 Agent；简单报价或单项数据改用 finance，不为机械盯行情启动，只允许研究与模拟分析.',
      tools: [tradingAgent],
    })
  }

  const website = resolveOptionalTool(deps.optionalTools, 'website', maybeCreateWebsiteTool)
  if (website) {
    capabilities.push({
      name: 'website',
      description: 'Luna 个人网站维护: 读取、写入、删除和移动 Astro 内容文件, 构建检查, commit 并 push 到配置分支.',
      tools: [website],
    })
  }

  const webSearch = resolveOptionalTool(deps.optionalTools, 'webSearch', maybeCreateWebSearchTool)
  capabilities.push({
    name: 'external_research',
    description: '外部内容与研究: 搜索互联网、抓普通网页和读取 Reddit.',
    tools: webSearch ? [webSearch, externalResearchFetchContent] : [externalResearchFetchContent],
    acceptsToolCall: (toolName, args) => (
      toolName !== 'fetch_content' || fetchContentScopeAccepts('external_research', args)
    ),
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
      description: '同类多步规则反复出现、现有 skill 未覆盖且能写清使用与排除边界时，创建、校验并安装运行时 skill；一次性任务、临时笔记和当前执行状态不要做成 skill.',
      tools: [skillEditorTool],
    },
    {
      name: 'media_inspection',
      description: '主动查看已有图片: 补跑入站图片描述并把真实预览作为 image block 放进当前上下文.',
      tools: [createInspectMediaTool({ taskScheduler })],
    },
    {
      name: 'media_generation',
      description: 'AI 图片生成和基于已有图片的编辑.',
      tools: [createGenerateImageTool({ taskRegistry: deps.taskRegistry })],
    },
    {
      name: 'media_fetch',
      description: '下载图片 URL 或 QQ 头像, 生成可发送、编辑或收藏的 image handle.',
      tools: [mediaFetchContent],
      acceptsToolCall: (toolName, args) => (
        toolName !== 'fetch_content' || fetchContentScopeAccepts('media_fetch', args)
      ),
    },
  )

  return {
    alwaysOnTools: tools.map(applyBotToolPolicy),
    capabilities: capabilities.map((capability) => ({
      ...capability,
      tools: capability.tools.map(applyBotToolPolicy),
    })),
  }
}

function resolveOptionalTool(
  overrides: BotOptionalTools | undefined,
  name: keyof BotOptionalTools,
  factory: () => Tool | null,
): Tool | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] ?? null
  }
  return factory()
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const manifest = buildBotToolManifest(deps)
  return createDeferredToolExecutor(manifest).list()
}
