import { createDeferredToolExecutor, type DeferredToolCapability, type Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import type { GroupCustomization } from '../../config/group-prompts.js'
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
import { createFetchContentTool } from './fetch-content.js'
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
import type { DurableWakeScheduler } from '../durable-wake-scheduler.js'
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

export interface BotToolDeps {
  sender: MessageSender
  targetPolicy: SendTargetPolicy
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  selfNumber: number
  metadata: TargetMetadataMaps
  groupCustomizations: readonly GroupCustomization[]
  qqDirectory: QqDirectoryDeps
  optionalTools?: BotOptionalTools
  taskScheduler?: TaskScheduler
  wakeScheduler?: DurableWakeScheduler
  llm?: LlmClient
  approvalManager?: ApprovalManager
  mcpManager?: McpManager
  goalStore?: GoalStore
  memoryMaintenance?: MemoryMaintenanceRuntime
  workspaceDir?: string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
  restGuide?: {
    pickIdleIntention?(): Promise<{
      ok: boolean
      intention: string | null
      whyNow?: string | null
      firstStep?: string | null
      promoteToGoal?: boolean
    }>
  }
  canConfirmRestAlternative?: () => boolean
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
  const fetchContent = createFetchContentTool({
    taskRegistry: deps.taskRegistry,
    taskScheduler,
  })
  const cryptoPaper = resolveOptionalTool(deps.optionalTools, 'cryptoPaper', maybeCreateCryptoPaperTool)
  const tradingAgent = resolveOptionalTool(
    deps.optionalTools,
    'tradingAgent',
    () => maybeCreateTradingAgentTool({ taskRegistry: deps.taskRegistry }) ?? null,
  )
  const qqDirectory = createQqDirectoryTool(deps.qqDirectory)
  const backgroundTask = createBackgroundTaskTool({ taskRegistry: deps.taskRegistry })
  const inbox = createInboxTool({ groupIds: deps.groupIds, selfNumber: deps.selfNumber })
  const chatStyle = createChatStyleTool({
    groupIds: deps.groupIds,
    metadata: deps.metadata,
    groupCustomizations: deps.groupCustomizations,
  })
  const aiTone = createAiToneTool()
  const pickIdleIntention = deps.restGuide?.pickIdleIntention?.bind(deps.restGuide)
  const pause = createPauseTool({
    rest: pickIdleIntention || deps.canConfirmRestAlternative
      ? {
          ...(pickIdleIntention
            ? {
                pickAlternative: async () => {
                  const picked = await pickIdleIntention()
                  if (!picked.ok || !picked.intention) return null
                  return {
                    direction: picked.intention,
                    whyNow: picked.whyNow ?? null,
                    firstStep: picked.firstStep ?? picked.intention,
                    promoteToGoal: picked.promoteToGoal ?? false,
                  }
                },
              }
            : {}),
          canConfirmAlternative: deps.canConfirmRestAlternative,
        }
      : undefined,
  })
  const workspaceBash = createWorkspaceBashTool({
    groupIdWhitelist: deps.groupIds,
    groupIds: deps.groupIds,
    metadata: deps.metadata,
    groupCustomizations: deps.groupCustomizations,
  })
  const delegate = deps.llm ? createDelegateTool({
    llm: deps.llm,
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    safeTools: [workspaceBash, inbox, qqDirectory, chatStyle, aiTone, skillTool, backgroundTask],
  }) : null
  const tools: Tool[] = [
    pause,
    createSendMessageTool({
      sender: deps.sender,
      targetPolicy: deps.targetPolicy,
    }),
    qqDirectory,
    backgroundTask,
    ...(deps.wakeScheduler ? [createScheduleTool(deps.wakeScheduler)] : []),
    ...(delegate ? [delegate] : []),
    ...(deps.approvalManager ? [createApprovalTool(deps.approvalManager)] : []),
    ...(deps.goalStore ? [createGoalTool(deps.goalStore)] : []),
    todoTool,
    skillTool,
    createMemoryTool({
      workspaceDir: deps.workspaceDir,
      maintenance: deps.memoryMaintenance,
      workspaceStateCoordinator: deps.workspaceStateCoordinator,
    }),
    inbox,
    collectStickerTool,
    chatStyle,
    aiTone,
    createNotebookTool({
      rootDir: deps.workspaceDir,
      workspaceStateCoordinator: deps.workspaceStateCoordinator,
    }),
    createLifeJournalTool({
      rootDir: deps.workspaceDir,
      workspaceStateCoordinator: deps.workspaceStateCoordinator,
    }),
    ...(cryptoPaper ? [cryptoPaper] : []),
    workspaceBash,
  ]
  const capabilities: DeferredToolCapability[] = []

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
      description: '委派多步金融研究、策略设计和历史回测给本机 Vibe-Trading 子 Agent; 只允许研究与模拟分析.',
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
      tools: [fetchContent],
    },
  )

  return { alwaysOnTools: tools, capabilities }
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
